import { BACKOFF_BASE_MS, BACKOFF_CAP_MS } from '../constants'

export function backoffMs(attempt: number, baseMs = BACKOFF_BASE_MS): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 16)
  return Math.min(baseMs * 2 ** exponent, BACKOFF_CAP_MS)
}
