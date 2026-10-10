/** Payload collection slug for the append-only audit trail. */
export const AUDIT_LOGS_SLUG = 'audit-logs'

/** Written in place of a secret. The raw value is never stored. */
export const REDACTED_VALUE = '[REDACTED]'

/**
 * Request-context key for the beforeChange / beforeDelete snapshot.
 * A string key is required: Payload copies `req.context` with object spread,
 * which drops symbol keys.
 */
export const AUDIT_CONTEXT_KEY = '__auditTrail'

/** Bookkeeping fields that change on every write and are not business data. */
export const IGNORED_DIFF_PATHS = new Set(['id', 'createdAt', 'updatedAt', 'collection'])

/** Max JSON length stored for a single old or new value. */
export const MAX_LOGGED_VALUE_CHARS = 4000
