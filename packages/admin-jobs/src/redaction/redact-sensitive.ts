import { REDACTED } from '../constants'
import { isSecretKey } from './secret-key'

const MAX_DEPTH = 8
const MAX_KEYS = 40
const MAX_ARRAY = 40

const SECRET_ASSIGNMENT =
  /\b(password|passwd|secret|token|api[_-]?key|authorization|cookie|session|credential)\b\s*[:=]\s*\S+/gi

export function redactText(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT, '$1=[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return REDACTED
  }
  if (typeof value === 'string') {
    return redactText(value)
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => redactSensitive(item, depth + 1))
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
    output[key] = isSecretKey(key) ? REDACTED : redactSensitive(nested, depth + 1)
  }
  return output
}
