import { timingSafeEqual } from 'node:crypto'

import { JOBS_INTERNAL_HOST, JOBS_WORKER_PATH } from './worker-dispatch'

export { JOBS_INTERNAL_HEADER } from './worker-dispatch'

export const JOBS_INTERNAL_SECRET_PLACEHOLDER = 'placeholder-jobs-internal-secret'
export const JOBS_INTERNAL_SECRET_MIN_LENGTH = 32

let loggedSkip = false

export function internalSecretRefusal(
  secret: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string | null {
  if (nodeEnv !== 'production') {
    return null
  }
  if (!secret) {
    return 'JOBS_INTERNAL_SECRET is missing. Set it with `wrangler secret put JOBS_INTERNAL_SECRET`. Use at least 32 characters, and do not use the placeholder from .env.example.'
  }
  if (secret === JOBS_INTERNAL_SECRET_PLACEHOLDER) {
    return 'JOBS_INTERNAL_SECRET is still the placeholder. Set a new value with `wrangler secret put JOBS_INTERNAL_SECRET`.'
  }
  if (secret.length < JOBS_INTERNAL_SECRET_MIN_LENGTH) {
    return `JOBS_INTERNAL_SECRET must be at least ${JOBS_INTERNAL_SECRET_MIN_LENGTH} characters. Set it with \`wrangler secret put JOBS_INTERNAL_SECRET\`.`
  }
  return null
}

export function secretsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

export type InternalDispatch = { action: 'allow' } | { action: 'not-found' } | { action: 'skip'; reason: string }

export function decideInternalDispatch(args: {
  header: string | null
  hostname: string
  nodeEnv?: string
  pathname: string
  secret: string | undefined
}): InternalDispatch {
  if (args.hostname !== JOBS_INTERNAL_HOST || args.pathname !== JOBS_WORKER_PATH) {
    return { action: 'not-found' }
  }
  const refusal = internalSecretRefusal(args.secret, args.nodeEnv)
  if (refusal) {
    return { action: 'skip', reason: refusal }
  }
  if (!args.secret || !secretsMatch(args.header ?? '', args.secret)) {
    return { action: 'not-found' }
  }
  return { action: 'allow' }
}

export function logInternalSkipOnce(reason: string, log: (message: string) => void = console.error): void {
  if (loggedSkip) {
    return
  }
  loggedSkip = true
  log(`Jobs worker skipped: ${reason}`)
}

export function resetInternalSecretLogForTests(): void {
  loggedSkip = false
}
