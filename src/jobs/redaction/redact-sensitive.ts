import { REDACTED } from '../constants'

const SENSITIVE_KEY =
  /pass(?:word|wd)?|secret|token|auth(?:orization)?|api[_-]?key|cookie|session|credential|private[_-]?key|salt|ssn|otp|\bpin\b/i

const MAX_DEPTH = 8
const MAX_KEYS = 40
const MAX_ARRAY = 40

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return REDACTED
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => redactSensitive(item, depth + 1))
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(nested, depth + 1)
  }
  return output
}
