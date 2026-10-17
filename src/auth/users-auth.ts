import type { IncomingAuthType } from 'payload'

/** Payload's own per-account lockout, kept at its defaults and stated explicitly. */
export const USERS_MAX_LOGIN_ATTEMPTS = 5
export const USERS_LOCK_TIME_MS = 10 * 60 * 1000

/** Auth options for the `users` collection. Production cookies are `Secure`. */
export function usersAuthOptions(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): IncomingAuthType {
  return {
    cookies: {
      secure: nodeEnv === 'production',
      sameSite: 'Lax',
    },
    maxLoginAttempts: USERS_MAX_LOGIN_ATTEMPTS,
    lockTime: USERS_LOCK_TIME_MS,
  }
}
