import { computeFieldDiff } from '../diff/computeFieldDiff'
import { asRecord } from '../diff/isPlainObject'
import { mergeFieldChanges } from '../diff/mergeFieldChanges'
import { projectBeforeOntoAfter } from '../diff/projectBeforeOntoAfter'
import type { SensitiveFieldPolicy } from '../diff/SensitiveFieldPolicy'
import { changesForSubmittedSecrets } from '../diff/submittedSecretPaths'
import { writeOnlySecretChanges } from '../diff/writeOnlySecretChanges'
import type { AuditAction, RequestAuditMetadata } from '../types'
import type { CapturedAuditContext } from '../request/AuditContextStore'
import { buildAuditLogEntry } from './buildAuditLogEntry'
import type { AuditFailureHandler, AuditLogWriter } from './AuditLogWriter'

export type AuditChangeArgs = {
  collectionSlug: string
  operation: 'create' | 'update'
  data: unknown
  doc: unknown
  previousDoc: unknown
  captured: CapturedAuditContext | undefined
  metadata: RequestAuditMetadata
  policy: SensitiveFieldPolicy
  writer: AuditLogWriter
  onFailure: AuditFailureHandler
}

/**
 * Builds the field diff from the beforeChange snapshot and the saved document,
 * then asks the writer to persist it. Any failure is reported and swallowed.
 */
export async function runAuditChange(args: AuditChangeArgs): Promise<void> {
  try {
    const rawBefore = args.captured
      ? args.captured.originalDoc
      : args.operation === 'create'
        ? null
        : asRecord(args.previousDoc)
    const after = asRecord(args.doc)
    const before = projectBeforeOntoAfter(rawBefore, after)
    const action: AuditAction = args.operation === 'create' ? 'CREATE' : 'UPDATE'
    const changes = mergeFieldChanges(
      computeFieldDiff(before, after, args.policy),
      [
        ...changesForSubmittedSecrets(args.captured?.submittedSecretPaths ?? [], action),
        ...writeOnlySecretChanges(args.data, rawBefore, after, action, args.policy),
      ],
    )
    if (action === 'UPDATE' && changes.length === 0) return

    const documentId = readDocumentId(args.doc)
    await args.writer.write(
      buildAuditLogEntry({
        action,
        changes,
        collectionSlug: args.collectionSlug,
        documentId,
        metadata: args.metadata,
      }),
    )
  } catch (error) {
    args.onFailure(
      error,
      `Audit trail failed for ${args.collectionSlug}; the original change was kept.`,
    )
  }
}

export async function runAuditDelete(args: {
  collectionSlug: string
  id: number | string
  doc: unknown
  metadata: RequestAuditMetadata
  policy: SensitiveFieldPolicy
  writer: AuditLogWriter
  onFailure: AuditFailureHandler
}): Promise<void> {
  try {
    const changes = computeFieldDiff(asRecord(args.doc), null, args.policy)
    await args.writer.write(
      buildAuditLogEntry({
        action: 'DELETE',
        changes,
        collectionSlug: args.collectionSlug,
        documentId: String(args.id),
        metadata: args.metadata,
      }),
    )
  } catch (error) {
    args.onFailure(
      error,
      `Audit trail failed for delete of ${args.collectionSlug} #${String(args.id)}; the original change was kept.`,
    )
  }
}

function readDocumentId(doc: unknown): string {
  const record = asRecord(doc)
  const id = record?.id
  return id == null ? '' : String(id)
}
