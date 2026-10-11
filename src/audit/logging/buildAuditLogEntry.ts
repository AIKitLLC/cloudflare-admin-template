import { buildChangeSummary } from '../diff/buildChangeSummary'
import type { AuditAction, AuditLogEntry, FieldChange, RequestAuditMetadata } from '../types'

export function buildAuditLogEntry(input: {
  action: AuditAction
  collectionSlug: string
  documentId: string
  changes: FieldChange[]
  metadata: RequestAuditMetadata
  occurredAt?: string
}): AuditLogEntry {
  return {
    action: input.action,
    collectionSlug: input.collectionSlug,
    documentId: input.documentId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    summary: buildChangeSummary(input),
    changes: input.changes,
    metadata: input.metadata,
  }
}
