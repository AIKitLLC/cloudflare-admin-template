import { MAX_LOGGED_VALUE_CHARS, REDACTED_VALUE } from '../constants'

/** Keeps a single logged value inside a D1-friendly size. */
export function boundLoggedValue(value: unknown): unknown {
  if (value == null || value === REDACTED_VALUE) return value
  const serialized = JSON.stringify(value)
  if (serialized.length <= MAX_LOGGED_VALUE_CHARS) return value
  return {
    truncated: true,
    preview: serialized.slice(0, MAX_LOGGED_VALUE_CHARS),
  }
}
