import type { AuditLogEntry } from '../types'

export interface AuditLogWriter {
  write(entry: AuditLogEntry): Promise<void>
}

export type AuditFailureHandler = (error: unknown, message: string) => void
