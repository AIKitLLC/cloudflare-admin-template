import type { Payload, RequiredDataFromCollectionSlug } from 'payload'

import { AUDIT_LOGS_SLUG } from '../constants'
import type { AuditLogEntry } from '../types'
import type { AuditLogWriter } from './AuditLogWriter'

type AuditLogData = RequiredDataFromCollectionSlug<'audit-logs'>
type JsonValue = NonNullable<NonNullable<AuditLogData['changes']>[number]['oldValue']>

/**
 * Writes one audit row outside the caller's Payload operation.
 *
 * The D1 adapter does not start a transaction unless `transactionOptions` is set
 * (`defaultBeginTransaction` resolves to null). A thrown afterChange hook would
 * still fail the HTTP response after the user's row was committed. This writer
 * is therefore invoked from a try/catch and is also isolated from any future
 * transaction:
 *
 * - `req` is omitted, so the insert cannot join the caller's transaction id.
 * - `disableTransaction` is set so this insert does not open one of its own.
 *
 * If the operator relationship points at a user row that was just deleted,
 * SQLite raises a foreign-key error and the insert is retried with the
 * relationship cleared. Other errors are not retried, so a committed row is
 * not written twice. The operator id and email snapshots stay on the entry.
 */
export class PayloadAuditLogWriter implements AuditLogWriter {
  constructor(private readonly payload: Payload) {}

  async write(entry: AuditLogEntry): Promise<void> {
    const data = toAuditData(entry)
    try {
      await this.insert(data)
    } catch (error) {
      if (data.actor == null || !isForeignKeyError(error)) throw error
      await this.insert({ ...data, actor: null })
    }
  }

  private insert(data: AuditLogData): Promise<unknown> {
    return this.payload.create({
      collection: AUDIT_LOGS_SLUG,
      data,
      depth: 0,
      disableTransaction: true,
      overrideAccess: true,
    })
  }
}

function toAuditData(entry: AuditLogEntry): AuditLogData {
  const actor = entry.metadata.actorRelationshipId
  return {
    action: entry.action,
    actor: typeof actor === 'number' ? actor : null,
    actorEmail: entry.metadata.actorEmail,
    operatorId: entry.metadata.actorId,
    changes: entry.changes.map((change) => ({
      path: change.path,
      oldValue: toJsonValue(change.oldValue),
      newValue: toJsonValue(change.newValue),
    })),
    collectionSlug: entry.collectionSlug,
    documentId: entry.documentId,
    ipAddress: entry.metadata.ipAddress,
    occurredAt: entry.occurredAt,
    summary: entry.summary,
    userAgent: entry.metadata.userAgent,
  }
}

function isForeignKeyError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /foreign key/i.test(message)
}

function toJsonValue(value: unknown): JsonValue {
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item))
  if (typeof value === 'object') return value as Record<string, unknown>
  return String(value)
}
