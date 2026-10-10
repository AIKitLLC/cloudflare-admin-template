import type { JOB_STATUSES } from './constants'

export type JobStatus = (typeof JOB_STATUSES)[number]

export type JobLogEntry = {
  at: string
  message: string
}

export type JobContext<TPayload> = {
  attempt: number
  heartbeat: () => Promise<boolean>
  idempotencyKey: string
  jobId: number | string
  log: (message: string) => void
  payload: TPayload
  signal: AbortSignal
}

export type JobDefinition<TPayload> = {
  backoffBaseMs?: number
  execute: (context: JobContext<TPayload>) => Promise<void>
  leaseMs?: number
  maxAttempts?: number
  name: string
  permissionKey?: string
  requiresFullAccess?: boolean
  validate: (input: unknown) => TPayload
}

export type JobQueueMessage = {
  jobId: number
}

export type StoredJob = {
  attempt: number
  claimToken?: string | null
  createdAt: string
  error?: string | null
  finishedAt?: string | null
  id: number | string
  idempotencyKey: string
  leaseExpiresAt?: string | null
  logs?: JobLogEntry[] | null
  maxAttempts: number
  name: string
  payload?: unknown
  runAt?: string | null
  startedAt?: string | null
  status: JobStatus
  updatedAt: string
}
