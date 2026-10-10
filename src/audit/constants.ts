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

/**
 * Set on the local API `context` by the audit writer when it appends change
 * rows or removes a partial log. REST and GraphQL callers cannot set this.
 * Payload copies `req.context` with object spread, which drops symbol keys.
 */
export const AUDIT_LOG_INTERNAL_WRITE = '__auditLogInternalWrite'

/** Bookkeeping fields that change on every write and are not business data. */
export const IGNORED_DIFF_PATHS = new Set(['id', 'createdAt', 'updatedAt', 'collection'])

/** Max JSON length stored for a single old or new value. */
export const MAX_LOGGED_VALUE_CHARS = 4000

/**
 * D1 allows 100 bound parameters per statement. A change row has six columns,
 * so 16 rows is the largest batch that stays under that limit (16 * 6 = 96).
 */
export const CHANGE_ROW_INSERT_CHUNK = 16

/** Hard cap on change rows stored for one audit log, including a truncation marker. */
export const MAX_CHANGE_ROWS = 64

/**
 * Comma-separated emails that may read audit logs, in addition to the first user.
 * Placeholder only. Do not commit real addresses.
 */
export const AUDIT_LOG_READER_EMAILS_ENV = 'AUDIT_LOG_READER_EMAILS'
