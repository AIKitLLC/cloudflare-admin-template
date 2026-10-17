export const JOBS_TABLE = 'jobs'

export const JOB_COLUMNS = {
  attempt: 'attempt',
  claimToken: 'claim_token',
  createdAt: 'created_at',
  error: 'error',
  finishedAt: 'finished_at',
  id: 'id',
  idempotencyKey: 'idempotency_key',
  leaseExpiresAt: 'lease_expires_at',
  logs: 'logs',
  maxAttempts: 'max_attempts',
  name: 'name',
  payload: 'payload',
  runAt: 'run_at',
  startedAt: 'started_at',
  status: 'status',
  updatedAt: 'updated_at',
} as const
