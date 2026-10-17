import { REDACTED_VALUE } from '../constants'
import { isPlainObject } from './isPlainObject'
import type { SensitiveFieldPolicy } from './SensitiveFieldPolicy'

/**
 * Returns a log-safe copy. Sensitive paths become the redaction marker
 * without the original value being copied onto the result.
 */
export function redactValue(path: string, value: unknown, policy: SensitiveFieldPolicy): unknown {
  if (value == null) return null
  if (path && policy.isSensitive(path)) return REDACTED_VALUE
  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(`${path}.${index}`, item, policy))
  }
  if (isPlainObject(value)) {
    const redacted: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const childPath = path ? `${path}.${key}` : key
      redacted[key] = redactValue(childPath, value[key], policy)
    }
    return redacted
  }
  return value
}
