import { capFieldChanges } from '../diff/capFieldChanges'
import { computeFieldDiff } from '../diff/computeFieldDiff'
import { asRecord } from '../diff/isPlainObject'
import { mergeFieldChanges } from '../diff/mergeFieldChanges'
import { normalizeRelations } from '../diff/normalizeRelations'
import { projectBeforeOntoAfter } from '../diff/projectBeforeOntoAfter'
import type { SensitiveFieldPolicy } from '../diff/SensitiveFieldPolicy'
import { changesForSubmittedSecrets } from '../diff/submittedSecretPaths'
import { whenSensitiveFieldNames } from '../diff/whenSensitiveFields'
import { writeOnlySecretChanges } from '../diff/writeOnlySecretChanges'
import type { AuditAction, RequestAuditMetadata } from '../types'
import type { CapturedAuditContext } from '../request/AuditContextStore'
import { buildAuditLogEntry } from './buildAuditLogEntry'
import { noteDroppedAuditWrite } from './droppedAuditWrites'
import type { AuditFailureHandler, AuditLogWriter } from './AuditLogWriter'

type FieldList = Parameters<typeof normalizeRelations>[1]

export type AuditChangeArgs = {
  collectionSlug: string
  operation: 'create' | 'update'
  data: unknown
  doc: unknown
  previousDoc: unknown
  captured: CapturedAuditContext | undefined
  fields: FieldList
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
    const action: AuditAction = args.operation === 'create' ? 'CREATE' : 'UPDATE'
    const rawBefore = action === 'CREATE' ? null : asRecord(args.previousDoc)
    const rawAfter = asRecord(args.doc)
    const before = projectBeforeOntoAfter(
      asRecord(normalizeRelations(rawBefore, args.fields)),
      asRecord(normalizeRelations(rawAfter, args.fields)),
    )
    const after = asRecord(normalizeRelations(rawAfter, args.fields))
    const policy = args.policy.and(whenSensitiveFieldNames(args.fields, [rawBefore, rawAfter]))
    const changes = capFieldChanges(
      mergeFieldChanges(
        computeFieldDiff(before, after, policy),
        [
          ...changesForSubmittedSecrets(args.captured?.submittedSecretPaths ?? [], action),
          ...writeOnlySecretChanges(args.data, rawBefore, after, action, policy),
        ],
      ),
      policy,
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
    noteDroppedAuditWrite()
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
  fields: FieldList
  metadata: RequestAuditMetadata
  policy: SensitiveFieldPolicy
  writer: AuditLogWriter
  onFailure: AuditFailureHandler
}): Promise<void> {
  try {
    const policy = args.policy.and(whenSensitiveFieldNames(args.fields, [args.doc]))
    const changes = capFieldChanges(
      computeFieldDiff(asRecord(normalizeRelations(args.doc, args.fields)), null, policy),
      policy,
    )
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
    noteDroppedAuditWrite()
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
