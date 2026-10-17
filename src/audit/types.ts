export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE'

export type FieldChange = {
  path: string
  oldValue: unknown
  newValue: unknown
}

/** Who performed the write, captured from the Payload request. */
export type RequestAuditMetadata = {
  actorId: string | null
  /** Id passed to the `actor` relationship. Null when the operator row may already be gone. */
  actorRelationshipId: number | string | null
  actorEmail: string | null
  /** `CF-Connecting-IP` only. Null when Cloudflare did not set it. */
  ipAddress: string | null
  /** `X-Forwarded-For` or `X-Real-IP`. Not a trusted client address. */
  untrustedClientIp: string | null
  userAgent: string | null
}

export type AuditLogEntry = {
  action: AuditAction
  collectionSlug: string
  documentId: string
  occurredAt: string
  summary: string
  changes: FieldChange[]
  metadata: RequestAuditMetadata
}
