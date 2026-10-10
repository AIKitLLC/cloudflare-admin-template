import type { AuditLogEntry } from '../types'
import { noteDroppedAuditWrite } from './droppedAuditWrites'
import type { AuditFailureHandler, AuditLogWriter } from './AuditLogWriter'

/**
 * Decorator: a failed audit insert is reported and swallowed.
 * The caller's document write has already been performed.
 */
export class FailOpenAuditLogWriter implements AuditLogWriter {
  constructor(
    private readonly inner: AuditLogWriter,
    private readonly onFailure: AuditFailureHandler,
  ) {}

  async write(entry: AuditLogEntry): Promise<void> {
    try {
      await this.inner.write(entry)
    } catch (error) {
      noteDroppedAuditWrite()
      this.onFailure(
        error,
        `Audit log write failed for ${entry.action} ${entry.collectionSlug} #${entry.documentId}; the original change was kept.`,
      )
    }
  }
}
