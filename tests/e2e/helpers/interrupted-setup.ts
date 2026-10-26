import { join } from 'node:path'

import type { APIRequestContext } from '@playwright/test'

import { api } from './api'
import { withDatabase } from './database'
import { uniqueIp } from './sign-in'

/** The second Worker's state (see `scripts/e2e/serve-worker.mjs`). Its database is this spec's own. */
export const STATE_DIR = join('.wrangler', 'e2e-interrupted')

export const interruptedAdmin = {
  email: 'interrupted-admin@example.com',
  password: 'interrupted-admin-password-123',
}

/** The stale-claim age: anything over `SETUP_CLAIM_TTL_MS` (2 minutes) can be taken over. */
export const STALE_CLAIM_MS = 10 * 60_000
/** A claim that may still belong to a running attempt. */
export const LIVE_CLAIM_MS = 5_000

export type SetupSnapshot = {
  claimToken: string | null
  completed: boolean
  users: string[]
  roleLinks: number
}

/** `POST /api/users/first-register` from a fresh address, as the setup screen sends it. */
export function register(
  request: APIRequestContext,
  { email, password }: { email: string; password: string },
  baseURL: string,
) {
  return api(request, {
    method: 'POST',
    path: '/api/users/first-register',
    ip: uniqueIp(),
    headers: { origin: baseURL },
    data: { email, password, 'confirm-password': password },
  })
}

/** What the setup claim and the users look like now. */
export function setupSnapshot(): Promise<SetupSnapshot> {
  return withDatabase(
    true,
    (db) => {
      const state = db.prepare('SELECT claim_token, completed_at FROM setup_state').get() as {
        claim_token: string | null
        completed_at: number | null
      }
      const users = db.prepare('SELECT email FROM users ORDER BY id').all() as { email: string }[]
      const links = db
        .prepare("SELECT count(*) AS n FROM users_rels WHERE path = 'roles'")
        .get() as { n: number }
      return {
        claimToken: state.claim_token,
        completed: state.completed_at !== null,
        users: users.map((user) => user.email),
        roleLinks: links.n,
      }
    },
    STATE_DIR,
  )
}

/**
 * Setup as a finished, healthy install: one user (the admin, created by a real first-register
 * the first time), the Super Admin role linked, the claim released and setup completed. Removes
 * every other user.
 */
export async function sealedSetup(request: APIRequestContext, baseURL: string): Promise<void> {
  const before = await setupSnapshot().catch((): null => null)
  if (!before || before.users.length === 0) {
    const created = await register(request, interruptedAdmin, baseURL)
    if (created.status !== 200) {
      throw new Error(`The first setup answered ${created.status}: ${created.message}`)
    }
  }
  await withDatabase(
    false,
    (db) => {
      db.prepare('DELETE FROM users WHERE email != ?').run(interruptedAdmin.email)
      const admin = db
        .prepare('SELECT id FROM users WHERE email = ?')
        .get(interruptedAdmin.email) as {
        id: number
      }
      const role = db.prepare("SELECT id FROM roles WHERE slug = 'super-admin'").get() as {
        id: number
      }
      db.prepare("DELETE FROM users_rels WHERE path = 'roles'").run()
      db.prepare(
        'INSERT INTO users_rels ("order", parent_id, path, roles_id) VALUES (1, ?, ?, ?)',
      ).run(admin.id, 'roles', role.id)
      db.prepare(
        'UPDATE setup_state SET completed_at = ?, claim_token = NULL, claimed_at = NULL',
      ).run(Date.now())
    },
    STATE_DIR,
  )
}

/**
 * Turns a sealed setup into the state of an attempt that died after creating the user: setup
 * not completed, a dead claim of the given age, and the user without its Super Admin role.
 */
export async function interruptSetup({ claimAgeMs }: { claimAgeMs: number }): Promise<void> {
  await withDatabase(
    false,
    (db) => {
      db.prepare(
        "UPDATE setup_state SET completed_at = NULL, claim_token = 'dead-attempt', claimed_at = ?",
      ).run(Date.now() - claimAgeMs)
      db.prepare("DELETE FROM users_rels WHERE path = 'roles'").run()
    },
    STATE_DIR,
  )
}
