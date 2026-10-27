import { randomUUID } from 'node:crypto'

import {
  addDataAndFileToRequest,
  APIError,
  Forbidden,
  headersWithCors,
  type CollectionBeforeChangeHook,
  type CollectionSlug,
  type Endpoint,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { generatePayloadCookie } from 'payload/shared'

import { USERS_SLUG } from '../access'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '../access'
import { ensureSuperAdminRole } from '../rbac'
import { admitAuthAttempt, type LoginThrottleDatabase } from './login-throttle'
import { USER_PASSWORD_MIN_LENGTH } from './password-policy'

export const SETUP_STATE_SLUG = 'setup-state'
export const SETUP_STATE_TABLE = 'setup_state'
/** Value of the unique `singleton` column on the only setup row. */
export const FIRST_ADMIN_SETUP_KEY = 'first-admin'
/** A claim left behind by a request that never finished can be taken over after this. */
export const SETUP_CLAIM_TTL_MS = 2 * 60 * 1000
/** `req.context` key that carries the active setup claim into the `users` create hooks. */
export const FIRST_ADMIN_SETUP_CONTEXT = 'firstAdminSetupClaim'
export const FIRST_ADMIN_PASSWORD_MIN_LENGTH = USER_PASSWORD_MIN_LENGTH

export type SetupStateDatabase = LoginThrottleDatabase

/**
 * Database guard for first-run setup. While a setup claim is live, `users` can hold at most
 * one row: a second insert is aborted by SQLite, whichever request or process attempts it.
 * Payload writes updates as `INSERT ... ON CONFLICT(id) DO UPDATE`, so a write to an existing
 * id is let through.
 * Created by migration `20261017_144000_setup_state` and, idempotently, before each claim
 * (local development and tests build the schema without migrations).
 */
export const SETUP_GUARD_TRIGGER = 'setup_state_single_first_admin'
const SETUP_GUARD_MESSAGE = 'first-run setup already created a user'
export const SETUP_GUARD_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS ${SETUP_GUARD_TRIGGER}
BEFORE INSERT ON users
WHEN EXISTS (
  SELECT 1 FROM setup_state
  WHERE singleton = '${FIRST_ADMIN_SETUP_KEY}'
    AND claim_token IS NOT NULL
    AND claimed_at > (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - ${SETUP_CLAIM_TTL_MS})
) AND EXISTS (SELECT 1 FROM users)
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, '${SETUP_GUARD_MESSAGE}');
END`

/**
 * Setup row writes. Every method is one SQL statement, so D1 applies each one atomically:
 * - `claim` succeeds for exactly one caller while `users` is empty, no other claim is live,
 *   and setup has not completed (the CLI passes `afterCompletion` to recover an empty table).
 * - `complete` records `completed_at` permanently; the web flow never reopens after it.
 * - `seal` records completion for installs that already have users. It leaves a live claim
 *   alone, so an early retry of an interrupted setup only refuses and recovery still runs once
 *   the claim is stale (#71).
 * - `interruptedUserId` / `completeInterrupted` recover a setup whose process died after it
 *   created the user but before it completed: a stale claim, no completion, exactly one user.
 *   With `afterCompletion` (the CLI) they also recover a run that claimed an emptied table.
 * - `ownUserId` finds the row a caller's own failed `create` committed.
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
    /**
     * Renews a claim this caller still holds and confirms `users` is still empty, in one
     * statement. False when the claim expired and was taken over, or a user exists.
     */
    async hold(token: string): Promise<boolean> {
      const now = nowMs()
      const row = await db
        .prepare(
          `UPDATE ${SETUP_STATE_TABLE} SET claimed_at = ?3
           WHERE singleton = ?1 AND claim_token = ?2 AND claimed_at > ?4
             AND NOT EXISTS (SELECT 1 FROM users)
           RETURNING claim_token`,
        )
        .bind(FIRST_ADMIN_SETUP_KEY, token, now, now - claimTtlMs)
        .first<{ claim_token: string | null }>()
      return row?.claim_token === token
    },
    async installGuard(): Promise<void> {
      await db.prepare(SETUP_GUARD_TRIGGER_SQL).bind().run()
    },
    async complete(token: string): Promise<boolean> {
      const row = await db
        .prepare(
          `UPDATE ${SETUP_STATE_TABLE} SET completed_at = ?3, claim_token = NULL, claimed_at = NULL
           WHERE singleton = ?1 AND claim_token = ?2
             AND (SELECT count(*) FROM users) = 1
           RETURNING singleton`,
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
             completed_at = COALESCE(${SETUP_STATE_TABLE}.completed_at, excluded.completed_at)
           WHERE ${SETUP_STATE_TABLE}.claim_token IS NULL OR ${SETUP_STATE_TABLE}.claimed_at <= ?3`,
        )
        .bind(FIRST_ADMIN_SETUP_KEY, nowMs(), nowMs() - claimTtlMs)
        .run()
    },
    /**
     * Id of the only user when a setup attempt died after creating it: its claim is still
     * stored but stale, and setup never completed (or, with `afterCompletion`, the attempt
     * claimed an emptied table). A live claim is left alone, so an attempt that is still
     * running is never recovered underneath it.
     */
    async interruptedUserId({ afterCompletion = false } = {}): Promise<number | string | null> {
      const row = await db
        .prepare(
          `SELECT users.id AS id FROM ${SETUP_STATE_TABLE}, users
           WHERE ${SETUP_STATE_TABLE}.singleton = ?1
             AND ${SETUP_STATE_TABLE}.claim_token IS NOT NULL
             AND (?3 = 1 OR ${SETUP_STATE_TABLE}.completed_at IS NULL)
             AND ${SETUP_STATE_TABLE}.claimed_at <= ?2
             AND (SELECT count(*) FROM users) = 1
           LIMIT 1`,
        )
        .bind(FIRST_ADMIN_SETUP_KEY, nowMs() - claimTtlMs, afterCompletion ? 1 : 0)
        .first<{ id: number | string }>()
      return row?.id ?? null
    },
    /** Marks an interrupted setup complete, re-checking its conditions in the same statement. */
    async completeInterrupted({ afterCompletion = false } = {}): Promise<boolean> {
      const row = await db
        .prepare(
          `UPDATE ${SETUP_STATE_TABLE} SET completed_at = ?2, claim_token = NULL, claimed_at = NULL
           WHERE singleton = ?1 AND (?4 = 1 OR completed_at IS NULL) AND claim_token IS NOT NULL
             AND claimed_at <= ?3 AND (SELECT count(*) FROM users) = 1
           RETURNING singleton`,
        )
        .bind(FIRST_ADMIN_SETUP_KEY, nowMs(), nowMs() - claimTtlMs, afterCompletion ? 1 : 0)
        .first<{ singleton: string }>()
      return row?.singleton === FIRST_ADMIN_SETUP_KEY
    },
    /**
     * Id of the only user while `token` still holds a live claim and that user has `email`:
     * the row this caller's own failed `create` committed. While the claim is live the guard
     * trigger refuses any insert into a non-empty table, so the row is not another request's.
     */
    async ownUserId(token: string, email: string): Promise<number | string | null> {
      const row = await db
        .prepare(
          `SELECT users.id AS id FROM ${SETUP_STATE_TABLE}, users
           WHERE ${SETUP_STATE_TABLE}.singleton = ?1
             AND ${SETUP_STATE_TABLE}.claim_token = ?2
             AND ${SETUP_STATE_TABLE}.claimed_at > ?3
             AND lower(users.email) = lower(?4)
             AND (SELECT count(*) FROM users) = 1
           LIMIT 1`,
        )
        .bind(FIRST_ADMIN_SETUP_KEY, token, nowMs() - claimTtlMs, email)
        .first<{ id: number | string }>()
      return row?.id ?? null
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

/** True when an error, or one of its causes, is the database guard refusing a second user. */
export function isSetupGuardError(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    const message = (current as { message?: unknown }).message
    if (typeof message === 'string' && message.includes(SETUP_GUARD_MESSAGE)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
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

/**
 * `users` `beforeChange` on create: inside first-run setup, renew the claim once more right
 * before Payload writes the row, so a request whose claim was taken over stops here.
 */
export const holdFirstAdminSetupClaim: CollectionBeforeChangeHook = async ({
  context,
  data,
  operation,
  req,
}) => {
  if (operation !== 'create' || !hasFirstAdminSetupClaim(context)) return data
  const db = setupStateBinding(req.payload)
  const token = (context as Record<string, string>)[FIRST_ADMIN_SETUP_CONTEXT]
  if (!db || !(await createSetupState(db).hold(token))) throw new Forbidden(req.t)
  return data
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
  if (current.some((value) => String(value) === String(role.id))) return user
  await payload.update({
    collection: 'users',
    id: Number(id),
    data: { roles: [...current.map(Number), Number(role.id)] },
    overrideAccess: true,
    req,
    context: { skipRbacBootstrap: true, [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
  })
  return user
}

export type FirstAdminSource = 'web' | 'cli'

/**
 * Creates the first admin under the setup claim and records completion. If any step fails
 * the account created by this call is removed and the claim is released, so a later attempt
 * starts from an empty `users` table again. If that removal fails too, the claim is kept: an
 * attempt left with its user, like one whose process died, is finished by the next attempt
 * once the claim is stale (see `interruptedUserId`).
 */
export async function createFirstAdminAccount(
  payload: Payload,
  input: FirstAdminInput,
  { source, req }: { source: FirstAdminSource; req?: PayloadRequest },
): Promise<{ id: number | string; email: string }> {
  const db = setupStateBinding(payload)
  if (!db) throw new APIError('First-run admin setup needs the D1 database binding.', 503)
  const state = createSetupState(db)
  await state.installGuard()
  // A previous attempt that died after creating its user left a stale claim behind. Finish
  // that setup for the existing user instead of refusing: no new account, no password change.
  const recovery = { afterCompletion: source === 'cli' }
  const interruptedId = await state.interruptedUserId(recovery)
  if (interruptedId !== null) {
    const existing = await ensureFirstAdminRole(payload, interruptedId, req)
    if (await state.completeInterrupted(recovery)) {
      payload.logger.info({
        msg: 'First-run setup recovered',
        userId: interruptedId,
        emailDomain: emailDomain(existing.email),
        source,
      })
      return { id: interruptedId, email: existing.email }
    }
  }
  if (source === 'web') await state.seal()
  const token = randomUUID()
  const refuse = () =>
    source === 'web'
      ? new Forbidden(req?.t)
      : new APIError(
          'A user already exists or another first-admin setup is running. Create further users from the admin panel.',
          409,
        )
  if (!(await state.claim(token, { afterCompletion: source === 'cli' }))) throw refuse()
  let created: { id: number | string; email: string } | undefined
  try {
    // Renew the claim right before the insert. A claim that expired and was taken over by
    // another caller stops here; the database guard covers the remaining window.
    if (!(await state.hold(token))) throw refuse()
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
    // D1 runs without transactions, so `create` can reject after its insert was committed
    // (a `users` hook failed). The guard refusal means this call inserted nothing.
    const ownId =
      created?.id ?? (isSetupGuardError(error) ? null : await state.ownUserId(token, input.email))
    // Remove only the account this call created, by its id. If the removal throws, the claim
    // is kept so the next attempt recovers this account instead of finding a stuck install.
    if (ownId !== null) {
      await payload.db.deleteMany({
        collection: USERS_SLUG as CollectionSlug,
        where: { id: { equals: ownId } },
        req,
      })
    }
    await state.release(token)
    if (isSetupGuardError(error)) throw refuse()
    throw error
  } finally {
    if (req?.context) delete req.context[FIRST_ADMIN_SETUP_CONTEXT]
  }
  if (!created) throw refuse()
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

function originOf(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

/**
 * The setup form posts from the admin panel, so browser requests are same-origin. A request
 * without `Origin` is accepted only when `Sec-Fetch-Site` is `same-origin` or `Referer` is on
 * an allowed origin.
 */
export function isSameOriginSetupRequest(req: PayloadRequest): boolean {
  const site = req.headers?.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const allowed = allowedOrigins(req)
  const origin = req.headers?.get('origin')
  if (origin) return allowed.has(origin)
  if (site === 'same-origin') return true
  const referer = originOf(req.headers?.get('referer'))
  return referer !== undefined && allowed.has(referer)
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
