import { createHash } from 'node:crypto'

import {
  APIError,
  type CollectionAfterLoginHook,
  type CollectionBeforeOperationHook,
  type PayloadRequest,
} from 'payload'

/** Failed sign-ins allowed per client IP in one window before login answers 429. */
export const LOGIN_THROTTLE_MAX_FAILURES = 10
export const LOGIN_THROTTLE_WINDOW_MS = 15 * 60 * 1000
export const LOGIN_THROTTLE_SLUG = 'login-throttle'
export const LOGIN_THROTTLE_TABLE = 'login_throttle'

export interface LoginThrottleDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>
      run(): Promise<unknown>
    }
  }
}

/** Cloudflare sets CF-Connecting-IP on every request that reaches the Worker. */
export function loginThrottleClientIp(headers: Headers | undefined): string {
  const value = headers?.get('cf-connecting-ip')?.trim() ?? ''
  if (!value || value.length > 64 || !/^[0-9A-Fa-f:.]+$/.test(value)) return 'unknown'
  return value.toLowerCase()
}

export function loginThrottleKey(ip: string): string {
  return createHash('sha256').update(`login-ip:${ip}`).digest('hex')
}

export type LoginThrottleResult = { allowed: boolean; used: number; resetAt: number }

/**
 * Counts one attempt for the key in a single statement, so concurrent requests cannot
 * both read the old count. A successful sign-in gives the attempt back (`release`).
 */
export function createLoginThrottle(
  db: LoginThrottleDatabase,
  {
    maxFailures = LOGIN_THROTTLE_MAX_FAILURES,
    windowMs = LOGIN_THROTTLE_WINDOW_MS,
    nowMs = Date.now,
  }: { maxFailures?: number; windowMs?: number; nowMs?: () => number } = {},
) {
  return {
    async record(key: string): Promise<LoginThrottleResult> {
      const now = nowMs()
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

function throttleFor(req: PayloadRequest) {
  const binding = (req.payload.db as unknown as { binding?: LoginThrottleDatabase }).binding
  if (!binding || typeof binding.prepare !== 'function') return undefined
  return createLoginThrottle(binding)
}

export const throttleLoginAttempt: CollectionBeforeOperationHook = async ({
  args,
  operation,
  req,
}) => {
  if (operation !== 'login' || req.payloadAPI === 'local') return args
  const throttle = throttleFor(req)
  if (!throttle) return args
  const { allowed } = await throttle.record(loginThrottleKey(loginThrottleClientIp(req.headers)))
  if (!allowed) {
    throw new APIError('Too many sign-in attempts. Try again later.', 429)
  }
  return args
}

export const releaseLoginAttempt: CollectionAfterLoginHook = async ({ req, user }) => {
  if (req.payloadAPI === 'local') return user
  await throttleFor(req)?.release(loginThrottleKey(loginThrottleClientIp(req.headers)))
  return user
}
