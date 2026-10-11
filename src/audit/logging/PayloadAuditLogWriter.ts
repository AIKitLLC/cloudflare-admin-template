import type { Payload, RequiredDataFromCollectionSlug } from 'payload'

import { AUDIT_LOGS_SLUG, AUDIT_LOG_INTERNAL_WRITE, CHANGE_ROW_INSERT_CHUNK } from '../constants'
import type { AuditLogEntry } from '../types'
import type { AuditLogWriter } from './AuditLogWriter'

type AuditLogData = RequiredDataFromCollectionSlug<'audit-logs'>
type JsonValue = NonNullable<NonNullable<AuditLogData['changes']>[number]['oldValue']>
type ChangeRow = NonNullable<AuditLogData['changes']>[number]

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
 * The parent row and the first batch of change rows are created together.
 * Further rows go through `payload.update`, which is the supported write path.
 * The D1 adapter then chunks those rows so a statement stays under 100 bound
 * parameters. `payload.db.insert` is not used.
 *
 * If a later batch fails, the partial log is deleted. Readers never see a
 * short diff that looks complete, and the failure counts as dropped. If that
 * delete also fails, the row is kept and marked `[incomplete]` with a
 * `_partial` change row, and the write is not counted as fully dropped.
 *
 * The insert stays on the request. `waitUntil` is not used: a detached insert
 * can outlive a failed request, and the worker can exit before it finishes,
 * dropping the row with no caller left to notice.
 */
export class PayloadAuditLogWriter implements AuditLogWriter {
  constructor(private readonly payload: Payload) {}

  async write(entry: AuditLogEntry): Promise<void> {
    const data = toAuditData(entry)
    try {
      await this.insertComplete(data)
    } catch (error) {
      if (data.actor == null || error instanceof AuditPartialWriteError || !isForeignKeyError(error)) {
        throw error
      }
      await this.insertComplete({ ...data, actor: null })
    }
  }

  private async insertComplete(data: AuditLogData): Promise<void> {
    const changes = data.changes ?? []
    const [first, ...rest] = chunk(changes, CHANGE_ROW_INSERT_CHUNK)
    const created = await this.insert({ ...data, changes: first ?? [] })
    if (rest.length === 0) return

    try {
      await this.payload.update({
        collection: AUDIT_LOGS_SLUG,
        id: created.id,
        data: { changes },
        context: internalWriteContext(),
        depth: 0,
        disableTransaction: true,
        overrideAccess: true,
      })
    } catch (error) {
      const removed = await this.compensatePartial(created.id, data, first ?? [])
      if (removed) throw new AuditPartialWriteError(error)
      this.payload.logger.error({
        err: error,
        msg: `Audit log #${created.id} is marked incomplete after a later change batch failed.`,
      })
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

  /**
   * @returns true when the partial row is gone. False when it had to be marked instead.
   */
  private async compensatePartial(
    id: number,
    data: AuditLogData,
    written: ChangeRow[],
  ): Promise<boolean> {
    try {
      await this.payload.delete({
        collection: AUDIT_LOGS_SLUG,
        id,
        context: internalWriteContext(),
        disableTransaction: true,
        overrideAccess: true,
      })
      return true
    } catch (deleteError) {
      this.payload.logger.error({
        err: deleteError,
        msg: `Could not remove partial audit log #${id}. Marking it incomplete.`,
      })
    }

    const summary = incompleteSummary(data.summary)
    const markedChanges = [
      ...written,
      {
        path: '_partial',
        oldValue: null,
        newValue: 'Later change rows failed and the partial log could not be removed.',
      },
    ]
    try {
      await this.payload.db.updateOne({
        collection: AUDIT_LOGS_SLUG,
        id,
        data: { summary, changes: markedChanges },
      })
      return false
    } catch (markError) {
      this.payload.logger.error({
        err: markError,
        msg: `Could not add a _partial row to audit log #${id}. Marking the summary.`,
      })
    }

    await this.payload.db.updateOne({
      collection: AUDIT_LOGS_SLUG,
      id,
      data: { summary },
    })
    return false
  }
}

class AuditPartialWriteError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Audit change rows failed after the log row was created.', {
      cause,
    })
    this.name = 'AuditPartialWriteError'
  }
}

function internalWriteContext(): { [AUDIT_LOG_INTERNAL_WRITE]: true } {
  return { [AUDIT_LOG_INTERNAL_WRITE]: true }
}

function incompleteSummary(summary: string | null | undefined): string {
  const base = summary && summary.length > 0 ? summary : 'Audit log'
  return base.includes('[incomplete]') ? base : `${base} [incomplete]`
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
