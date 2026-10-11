export const SYSTEM_PARAMETERS_SLUG = 'system-parameters' as const

export const PARAMETER_VALUE_TYPES = ['string', 'number', 'boolean', 'json'] as const

export const MAX_SLUG_LENGTH = 64
export const MAX_STRING_VALUE_LENGTH = 8_192
export const MAX_JSON_CHARS = 32_768
export const MAX_JSON_DEPTH = 32

/** How long an isolate may trust memory before it rechecks the shared version. */
export const PARAMETER_CACHE_VERIFY_TTL_MS = 2_000

/**
 * Forces a D1 reload even when the version still matches.
 * Covers a crashed process that saved the row and never bumped the version.
 */
export const PARAMETER_CACHE_MAX_AGE_MS = 30_000

/** Row in Payload's `payload_kv` table. Not a system parameter. */
export const PARAMETER_VERSION_STATE_KEY = 'system-parameters:version'

/**
 * Optional Workers KV binding. Commented out in wrangler.jsonc until a namespace exists.
 * Reads fall back to memory and D1 when this binding is absent.
 */
export const SYSTEM_PARAMETERS_KV_BINDING = 'SYSTEM_PARAMETERS_KV'

export const REVEAL_SENSITIVE_PARAMETER_VALUE = 'revealSensitiveParameterValue'
export const SYSTEM_PARAMETER_AUDIT_CONTEXT = 'systemParameterAudit'

export { AUDIT_REDACT_WHEN_SENSITIVE } from '@aikit/admin-core'

export const REDACTED_PARAMETER_VALUE = { redacted: true } as const
