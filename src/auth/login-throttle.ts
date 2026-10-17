import { createHash } from 'node:crypto'

import {
  APIError,
  type CollectionAfterLoginHook,
  type CollectionBeforeOperationHook,
  type PayloadRequest,
} from 'payload'

export const LOGIN_THROTTLE_WINDOW_MS = 15 * 60 * 1000
export const LOGIN_THROTTLE_SLUG = 'login-throttle'
export const LOGIN_THROTTLE_TABLE = 'login_throttle'
/** Expired rows removed per write, so the table stays bounded without a separate job. */
export const LOGIN_THROTTLE_CLEANUP_BATCH = 100

/**
 * Attempts allowed per client IP and window for each `users` auth operation. Each operation
 * has its own counter. Successful sign-ins are given back, so `login` counts failures.
 */
export const AUTH_THROTTLE_LIMITS = {
  login: 10,
  forgotPassword: 5,
  resetPassword: 10,
  refresh: 60,
} as const
export type ThrottledAuthOperation = keyof typeof AUTH_THROTTLE_LIMITS
export const LOGIN_THROTTLE_MAX_FAILURES = AUTH_THROTTLE_LIMITS.login

export function isThrottledAuthOperation(operation: string): operation is ThrottledAuthOperation {
  return Object.prototype.hasOwnProperty.call(AUTH_THROTTLE_LIMITS, operation)
}

export interface LoginThrottleDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>
      run(): Promise<unknown>
    }
  }
}

/** Cloudflare sets CF-Connecting-IP on every request that reaches the Worker. */
export function readClientIp(headers: Headers | undefined): string | undefined {
  const value = headers?.get('cf-connecting-ip')?.trim() ?? ''
  if (!value || value.length > 64 || !/^[0-9A-Fa-f:.]+$/.test(value)) return undefined
  return value.toLowerCase()
}

/** Outside production (local dev, tests) requests without the header share one counter. */
export function loginThrottleClientIp(headers: Headers | undefined): string {
  return readClientIp(headers) ?? 'unknown'
}

export function loginThrottleKey(ip: string, operation: ThrottledAuthOperation = 'login'): string {
  const scope = operation === 'login' ? 'login-ip' : `${operation}-ip`
  return createHash('sha256').update(`${scope}:${ip}`).digest('hex')
}

export type LoginThrottleResult = { allowed: boolean; used: number; resetAt: number }

/**
 * Counts one attempt for the key in a single statement, so concurrent requests cannot
 * both read the old count. `release` gives an attempt back after a successful sign-in.
 */
export function createLoginThrottle(
  db: LoginThrottleDatabase,
  {
    maxFailures = AUTH_THROTTLE_LIMITS.login,
    windowMs = LOGIN_THROTTLE_WINDOW_MS,
    nowMs = Date.now,
  }: { maxFailures?: number; windowMs?: number; nowMs?: () => number } = {},
) {
  return {
    async record(key: string): Promise<LoginThrottleResult> {
      const now = nowMs()
      await db
        .prepare(
          `DELETE FROM ${LOGIN_THROTTLE_TABLE} WHERE id IN (SELECT id FROM ${LOGIN_THROTTLE_TABLE} WHERE reset_at <= ?1 AND bucket_key <> ?2 LIMIT ${LOGIN_THROTTLE_CLEANUP_BATCH})`,
        )
        .bind(now, key)
        .run()
      const row = await db
        .prepare(
          `INSERT INTO ${LOGIN_THROTTLE_TABLE} (bucket_key, used, reset_at) VALUES (?1, 1, ?2)
           ON CONFLICT(bucket_key) DO UPDATE SET
             used = CASE WHEN ${LOGIN_THROTTLE_TABLE}.reset_at <= ?3 THEN 1 ELSE ${LOGIN_THROTTLE_TABLE}.used + 1 END,
             reset_at = CASE WHEN ${LOGIN_THROTTLE_TABLE}.reset_at <= ?3 THEN ?2 ELSE ${LOGIN_THROTTLE_TABLE}.reset_at END
           RETURNING used, reset_at`,
        )
        .bind(key, now + windowMs, now)
        .first<{ used: number; reset_at: number }>()
      const used = Number(row?.used ?? 0)
      const resetAt = Number(row?.reset_at ?? now + windowMs)
      return { allowed: used <= maxFailures, used, resetAt }
    },
    async release(key: string): Promise<void> {
      await db
        .prepare(
          `UPDATE ${LOGIN_THROTTLE_TABLE} SET used = MAX(used - 1, 0) WHERE bucket_key = ?1 AND reset_at > ?2`,
        )
        .bind(key, nowMs())
        .run()
    },
  }
}

function throttleBinding(req: PayloadRequest): LoginThrottleDatabase | undefined {
  const binding = (req.payload.db as unknown as { binding?: LoginThrottleDatabase }).binding
  return binding && typeof binding.prepare === 'function' ? binding : undefined
}

let loggedMissingBinding = false

/**
 * Applies the per-IP limit to one auth request. In production a request without
 * CF-Connecting-IP is refused, and a missing D1 binding refuses the request and logs once.
 */
export async function admitAuthAttempt(
  req: PayloadRequest,
  operation: ThrottledAuthOperation,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): Promise<void> {
  if (req.payloadAPI === 'local') return
  const production = nodeEnv === 'production'
  const db = throttleBinding(req)
  if (!db) {
    if (!production) return
    if (!loggedMissingBinding) {
      loggedMissingBinding = true
      console.error('Auth throttle: the D1 binding is unavailable; refusing auth requests.')
    }
    throw new APIError('Sign-in is temporarily unavailable.', 503)
  }
  const ip = readClientIp(req.headers)
  if (!ip && production) {
    throw new APIError('The client address is unavailable.', 400)
  }
  const throttle = createLoginThrottle(db, { maxFailures: AUTH_THROTTLE_LIMITS[operation] })
  const { allowed } = await throttle.record(loginThrottleKey(ip ?? 'unknown', operation))
  if (!allowed) {
    throw new APIError('Too many attempts. Try again later.', 429)
  }
}

export const throttleAuthOperation: CollectionBeforeOperationHook = async ({
  args,
  operation,
  req,
}) => {
  if (isThrottledAuthOperation(operation)) await admitAuthAttempt(req, operation)
  return args
}

export const releaseLoginAttempt: CollectionAfterLoginHook = async ({ req, user }) => {
  if (req.payloadAPI === 'local') return user
  const db = throttleBinding(req)
  if (!db) return user
  await createLoginThrottle(db).release(loginThrottleKey(loginThrottleClientIp(req.headers)))
  return user
}

export function resetAuthThrottleLogForTests(): void {
  loggedMissingBinding = false
}
