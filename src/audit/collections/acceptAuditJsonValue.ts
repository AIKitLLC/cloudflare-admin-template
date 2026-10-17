/**
 * Payload's built-in JSON validator runs JSON.parse on strings.
 * A plain value such as an email or "[REDACTED]" is valid audit data and is not JSON text.
 * Drizzle's json column still serializes every value on the way to D1.
 */
export function acceptAuditJsonValue(): true {
  return true
}
