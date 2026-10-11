import type { Payload } from 'payload'

import type { JobLogEntry, JobStatus } from '../types'
import { d1, type D1Budget } from './d1-client'
import { invokeJobChangeHooks } from './invoke-job-hooks'
import { JOB_COLUMNS, JOBS_TABLE } from './job-columns'
import { readStoredJob } from './read-stored-job'

export type FinishInput = {
  claimToken: string
  error?: string | null
  jobId: number | string
  logs?: JobLogEntry[]
  budget?: D1Budget
  now?: Date
  runAt?: string | null
  status: Extract<JobStatus, 'FAILED' | 'PENDING' | 'SUCCESS'>
}

export async function finishJob(payload: Payload, input: FinishInput): Promise<boolean> {
  const nowIso = (input.now ?? new Date()).toISOString()
  const previous = await readStoredJob(payload, input.jobId, { budget: input.budget })
  if (!previous) {
    return false
  }
  const clearClaim = input.status !== 'SUCCESS'
  const finishedAt = input.status === 'PENDING' ? null : nowIso
  const row = await d1(payload, input.budget)
    .prepare(
      `UPDATE ${JOBS_TABLE}
       SET ${JOB_COLUMNS.status} = ?,
           ${JOB_COLUMNS.error} = ?,
           ${JOB_COLUMNS.logs} = ?,
           ${JOB_COLUMNS.finishedAt} = ?,
           ${JOB_COLUMNS.runAt} = ?,
           ${JOB_COLUMNS.leaseExpiresAt} = NULL,
           ${JOB_COLUMNS.claimToken} = CASE WHEN ? = 1 THEN NULL ELSE ${JOB_COLUMNS.claimToken} END,
           ${JOB_COLUMNS.updatedAt} = ?
       WHERE ${JOB_COLUMNS.id} = ?
         AND ${JOB_COLUMNS.claimToken} = ?
         AND ${JOB_COLUMNS.status} = 'RUNNING'
       RETURNING ${JOB_COLUMNS.id} as id`,
    )
    .bind(
      input.status,
      input.error ?? null,
      JSON.stringify(input.logs ?? previous.logs ?? []),
      finishedAt,
      input.runAt ?? null,
      clearClaim ? 1 : 0,
      nowIso,
      input.jobId,
      input.claimToken,
    )
    .first<{ id: number }>()
  if (!row) {
    return false
  }
  const next = await readStoredJob(payload, input.jobId, { budget: input.budget })
  if (next) {
    await invokeJobChangeHooks(payload, previous, next)
  }
  return true
}
