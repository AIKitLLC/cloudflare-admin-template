import { randomUUID } from 'node:crypto'

import {
  addDataAndFileToRequest,
  APIError,
  Forbidden,
  headersWithCors,
  type CollectionSlug,
  type Endpoint,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { generatePayloadCookie } from 'payload/shared'

import { USERS_SLUG } from '../access/constants'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '../rbac/guards/privilege-context'
import { ensureSuperAdminRole } from '../rbac/seed/ensure-super-admin-role'
import { admitAuthAttempt, type LoginThrottleDatabase } from './login-throttle'

export const SETUP_STATE_SLUG = 'setup-state'
export const SETUP_STATE_TABLE = 'setup_state'
/** Value of the unique `singleton` column on the only setup row. */
export const FIRST_ADMIN_SETUP_KEY = 'first-admin'
/** A claim left behind by a request that never finished can be taken over after this. */
export const SETUP_CLAIM_TTL_MS = 2 * 60 * 1000
/** `req.context` key that carries the active setup claim into the `users` create hooks. */
export const FIRST_ADMIN_SETUP_CONTEXT = 'firstAdminSetupClaim'
export const FIRST_ADMIN_PASSWORD_MIN_LENGTH = 12

export type SetupStateDatabase = LoginThrottleDatabase

/**
 * Setup row writes. Every method is one SQL statement, so D1 applies each one atomically:
 * - `claim` succeeds for exactly one caller while `users` is empty, no other claim is live,
 *   and setup has not completed (the CLI passes `afterCompletion` to recover an empty table).
 * - `complete` records `completed_at` permanently; the web flow never reopens after it.
 * - `seal` records completion for installs that already have users.
 */
export function createSetupState(
  db: SetupStateDatabase,
  {
    nowMs = Date.now,
    claimTtlMs = SETUP_CLAIM_TTL_MS,
  }: { nowMs?: () => number; claimTtlMs?: number } = {},
) {
  return {
    async claim(token: string, { afterCompletion = false } = {}): Promise<boolean> {
      const now = nowMs()
      const row = await db
        .prepare(
          `INSERT INTO ${SETUP_STATE_TABLE} (singleton, claim_token, claimed_at)
           SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM users)
           ON CONFLICT(singleton) DO UPDATE SET
             claim_token = excluded.claim_token,
             claimed_at = excluded.claimed_at
           WHERE (${SETUP_STATE_TABLE}.claim_token IS NULL OR ${SETUP_STATE_TABLE}.claimed_at <= ?4)
             AND (?5 = 1 OR ${SETUP_STATE_TABLE}.completed_at IS NULL)
           RETURNING claim_token`,
        )
        .bind(FIRST_ADMIN_SETUP_KEY, token, now, now - claimTtlMs, afterCompletion ? 1 : 0)
        .first<{ claim_token: string | null }>()
      return row?.claim_token === token
    },
    async complete(token: string): Promise<boolean> {
      const row = await db
        .prepare(
          `UPDATE ${SETUP_STATE_TABLE} SET completed_at = ?3, claim_token = NULL, claimed_at = NULL
           WHERE singleton = ?1 AND claim_token = ?2 RETURNING singleton`,
        )
        .bind(FIRST_ADMIN_SETUP_KEY, token, nowMs())
        .first<{ singleton: string }>()
      return row?.singleton === FIRST_ADMIN_SETUP_KEY
    },
    async release(token: string): Promise<void> {
      await db
        .prepare(
          `UPDATE ${SETUP_STATE_TABLE} SET claim_token = NULL, claimed_at = NULL
           WHERE singleton = ?1 AND claim_token = ?2`,
        )
        .bind(FIRST_ADMIN_SETUP_KEY, token)
        .run()
    },
    async seal(): Promise<void> {
      await db
        .prepare(
          `INSERT INTO ${SETUP_STATE_TABLE} (singleton, completed_at)
           SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM users)
           ON CONFLICT(singleton) DO UPDATE SET
             completed_at = COALESCE(${SETUP_STATE_TABLE}.completed_at, excluded.completed_at)`,
        )
        .bind(FIRST_ADMIN_SETUP_KEY, nowMs())
        .run()
    },
    async completed(): Promise<boolean> {
      const row = await db
        .prepare(`SELECT completed_at FROM ${SETUP_STATE_TABLE} WHERE singleton = ?1`)
        .bind(FIRST_ADMIN_SETUP_KEY)
        .first<{ completed_at: number | null }>()
      return row?.completed_at !== null && row?.completed_at !== undefined
    },
  }
}

export function setupStateBinding(payload: Payload): SetupStateDatabase | undefined {
  const binding = (payload.db as unknown as { binding?: SetupStateDatabase }).binding
  return binding && typeof binding.prepare === 'function' ? binding : undefined
}

/** True while a `users` create runs inside an active first-run setup claim. */
export function hasFirstAdminSetupClaim(context: unknown): boolean {
  const value = (context as Record<string, unknown> | null | undefined)?.[FIRST_ADMIN_SETUP_CONTEXT]
  return typeof value === 'string' && value.length > 0
}

export type FirstAdminInput = { email: string; password: string }

export function validateFirstAdminInput(email: unknown, password: unknown): FirstAdminInput {
  const address = typeof email === 'string' ? email.trim() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) {
    throw new APIError('A valid email is required.', 400)
  }
  if (typeof password !== 'string' || password.length < FIRST_ADMIN_PASSWORD_MIN_LENGTH) {
    throw new APIError(
      `The password must be at least ${FIRST_ADMIN_PASSWORD_MIN_LENGTH} characters.`,
      400,
    )
  }
  return { email: address, password }
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase()
}

function roleIds(value: unknown): Array<number | string> {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : entry))
    .filter((id): id is number | string => typeof id === 'number' || typeof id === 'string')
}

/** Makes sure the first admin holds the Super Admin role before setup is marked complete. */
async function ensureFirstAdminRole(payload: Payload, id: number | string, req?: PayloadRequest) {
  const role = await ensureSuperAdminRole(payload)
  const user = await payload.findByID({
    collection: 'users',
    id: Number(id),
    depth: 0,
    overrideAccess: true,
    req,
  })
  const current = roleIds(user.roles)
  if (current.some((value) => String(value) === String(role.id))) return
  await payload.update({
    collection: 'users',
    id: Number(id),
    data: { roles: [...current.map(Number), Number(role.id)] },
    overrideAccess: true,
    req,
    context: { skipRbacBootstrap: true, [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
  })
}

export type FirstAdminSource = 'web' | 'cli'

/**
 * Creates the first admin under the setup claim and records completion. If any step fails
 * the account created by this call is removed and the claim is released, so a later attempt
 * starts from an empty `users` table again.
 */
export async function createFirstAdminAccount(
  payload: Payload,
  input: FirstAdminInput,
  { source, req }: { source: FirstAdminSource; req?: PayloadRequest },
): Promise<{ id: number | string; email: string }> {
  const db = setupStateBinding(payload)
  if (!db) throw new APIError('First-run admin setup needs the D1 database binding.', 503)
  const state = createSetupState(db)
  if (source === 'web') await state.seal()
  const token = randomUUID()
  if (!(await state.claim(token, { afterCompletion: source === 'cli' }))) {
    if (source === 'web') throw new Forbidden(req?.t)
    throw new APIError(
      'A user already exists or another first-admin setup is running. Create further users from the admin panel.',
      409,
    )
  }
  let created: { id: number | string; email: string }
  try {
    const user = await payload.create({
      collection: 'users',
      data: { email: input.email, password: input.password, role: 'admin' },
      overrideAccess: true,
      req,
      context: { [FIRST_ADMIN_SETUP_CONTEXT]: token },
    })
    created = { id: user.id, email: input.email }
    await ensureFirstAdminRole(payload, user.id, req)
    if (!(await state.complete(token))) {
      throw new APIError('First-run admin setup did not complete. Try again.', 409)
    }
  } catch (error) {
    try {
      await payload.db.deleteMany({
        collection: USERS_SLUG as CollectionSlug,
        where: { email: { equals: input.email } },
        req,
      })
    } finally {
      await state.release(token)
    }
    throw error
  } finally {
    if (req?.context) delete req.context[FIRST_ADMIN_SETUP_CONTEXT]
  }
  payload.logger.info({
    msg: 'First admin created',
    userId: created.id,
    emailDomain: emailDomain(created.email),
    source,
  })
  return created
}

function allowedOrigins(req: PayloadRequest): Set<string> {
  const origins = new Set<string>()
  try {
    origins.add(new URL(req.url ?? '').origin)
  } catch {
    // No request URL: only the configured origins apply.
  }
  const csrf = req.payload.config.csrf
  for (const value of Array.isArray(csrf) ? csrf : []) {
    try {
      origins.add(new URL(value).origin)
    } catch {
      // Ignore entries that are not URLs.
    }
  }
  return origins
}

/** The setup form posts from the admin panel, so browser requests are same-origin. */
export function isSameOriginSetupRequest(req: PayloadRequest): boolean {
  const site = req.headers?.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers?.get('origin')
  if (!origin) return true
  return allowedOrigins(req).has(origin)
}

/**
 * `POST /api/users/first-register`, used by the admin panel's create-first-user screen.
 * Takes the place of Payload's built-in handler and claims the setup row first.
 */
export const firstRegisterEndpoint: Endpoint = {
  path: '/first-register',
  method: 'post',
  handler: async (req) => {
    if (!isSameOriginSetupRequest(req)) throw new Forbidden(req.t)
    await admitAuthAttempt(req, 'registerFirstUser')
    await addDataAndFileToRequest(req)
    const input = validateFirstAdminInput(req.data?.email, req.data?.password)
    await createFirstAdminAccount(req.payload, input, { source: 'web', req })
    const { exp, token, user } = await req.payload.login({
      collection: USERS_SLUG as CollectionSlug,
      data: { email: input.email, password: input.password },
      req,
    })
    const cookie = generatePayloadCookie({
      collectionAuthConfig: req.payload.collections[USERS_SLUG as CollectionSlug].config.auth,
      cookiePrefix: req.payload.config.cookiePrefix,
      token: token!,
    })
    return Response.json(
      {
        exp,
        message: req.t('authentication:successfullyRegisteredFirstUser'),
        token,
        user: { ...user, collection: USERS_SLUG, _strategy: 'local-jwt' },
      },
      {
        headers: headersWithCors({ headers: new Headers({ 'Set-Cookie': cookie }), req }),
        status: 200,
      },
    )
  },
}
