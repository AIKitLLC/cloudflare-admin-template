import { randomUUID } from 'node:crypto'

import type { Payload, RequiredDataFromCollectionSlug } from 'payload'

import { AUDIT_LOGS_SLUG, CHANGE_ROW_INSERT_CHUNK } from '../constants'
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
 *
 * Change rows are inserted in batches of {@link CHANGE_ROW_INSERT_CHUNK}. D1
 * rejects a statement with more than 100 bound parameters, and each change row
 * uses six. The insert stays on the request. `waitUntil` is not used: a
 * detached insert can outlive a failed request, and the worker can exit before
 * it finishes, dropping the row with no caller left to notice.
 */
export class PayloadAuditLogWriter implements AuditLogWriter {
  constructor(private readonly payload: Payload) {}

  async write(entry: AuditLogEntry): Promise<void> {
    const data = toAuditData(entry)
    try {
      await this.insertParentAndChanges(data)
    } catch (error) {
      if (data.actor == null || !isForeignKeyError(error)) throw error
      await this.insertParentAndChanges({ ...data, actor: null })
    }
  }

  private async insertParentAndChanges(data: AuditLogData): Promise<void> {
    const changes = data.changes ?? []
    const [first, ...rest] = chunk(changes, CHANGE_ROW_INSERT_CHUNK)
    const created = await this.insert({ ...data, changes: first ?? [] })
    let written = first?.length ?? 0
    for (const batch of rest) {
      await this.insertChangeRows(created.id, batch, written)
      written += batch.length
    }
  }

  private insert(data: AuditLogData): Promise<{ id: number }> {
    return this.payload.create({
      collection: AUDIT_LOGS_SLUG,
      data,
      depth: 0,
      disableTransaction: true,
      overrideAccess: true,
    })
  }

  private async insertChangeRows(
    parentId: number,
    rows: NonNullable<AuditLogData['changes']>,
    alreadyWritten: number,
  ): Promise<void> {
    const db = this.payload.db as unknown as ChangeRowDb
    await db.insert({
      db: db.drizzle,
      tableName: 'audit_logs_changes',
      values: rows.map((row, index) => ({
        _order: alreadyWritten + index + 1,
        _parentID: parentId,
        id: randomUUID(),
        newValue: row.newValue ?? null,
        oldValue: row.oldValue ?? null,
        path: row.path,
      })),
    })
  }
}

type ChangeRowDb = {
  drizzle: unknown
  insert: (args: { db: unknown; tableName: string; values: Record<string, unknown>[] }) => Promise<unknown>
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
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
    untrustedClientIp: entry.metadata.untrustedClientIp,
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
