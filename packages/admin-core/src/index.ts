/** Shared field flag. Audit redacts the value when a document has `sensitive: true`. */
export const AUDIT_REDACT_WHEN_SENSITIVE = 'whenSensitive' as const

/** Payload's own tables. Feature packages do not wrap these. */
export const INTERNAL_COLLECTION_PREFIX = 'payload-'

export function isInternalCollection(slug: string): boolean {
  return slug.startsWith(INTERNAL_COLLECTION_PREFIX)
}
