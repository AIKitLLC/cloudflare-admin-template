import type { Payload } from 'payload'

import { BACKOFF_BASE_MS } from '../constants'
import { backoffMs } from '../delivery/backoff'
import { getJob } from '../registry/job-registry'
import { d1 } from './d1-client'
import { invokeJobChangeHooks } from './invoke-job-hooks'
import { JOB_COLUMNS, JOBS_TABLE } from './job-columns'
import { readStoredJob } from './read-stored-job'
import { selectExpiredLeaseIds } from './select-job-ids'

const LEASE_EXPIRED_ERROR = 'The running job exceeded its lease and was stopped.'

export async function reapExpiredLeases(
  payload: Payload,
  now = new Date(),
): Promise<{ failed: number; requeued: number }> {
  const ids = await selectExpiredLeaseIds(payload, now)
  let failed = 0
  let requeued = 0
  for (const id of ids) {
    const outcome = await reapOne(payload, id, now)
    if (outcome === 'FAILED') {
      failed += 1
    }
    if (outcome === 'PENDING') {
      requeued += 1
    }
  }
  return { failed, requeued }
}

async function reapOne(
  payload: Payload,
  jobId: number,
  now: Date,
): Promise<'FAILED' | 'PENDING' | null> {
  const previous = await readStoredJob(payload, jobId)
  if (!previous || previous.status !== 'RUNNING') {
    return null
  }
  const definition = getJob(previous.name)
  const delay = backoffMs(previous.attempt, definition?.backoffBaseMs ?? BACKOFF_BASE_MS)
  const nowIso = now.toISOString()
  const runAt = new Date(now.getTime() + delay).toISOString()
  const exhausted = previous.attempt >= previous.maxAttempts
  const row = await d1(payload)
    .prepare(
      `UPDATE ${JOBS_TABLE}
       SET ${JOB_COLUMNS.status} = ?,
           ${JOB_COLUMNS.error} = CASE WHEN ? = 1 THEN ? ELSE ${JOB_COLUMNS.error} END,
           ${JOB_COLUMNS.runAt} = ?,
           ${JOB_COLUMNS.finishedAt} = CASE WHEN ? = 1 THEN ? ELSE NULL END,
           ${JOB_COLUMNS.leaseExpiresAt} = NULL,
           ${JOB_COLUMNS.claimToken} = NULL,
           ${JOB_COLUMNS.updatedAt} = ?
       WHERE ${JOB_COLUMNS.id} = ?
         AND ${JOB_COLUMNS.status} = 'RUNNING'
         AND ${JOB_COLUMNS.leaseExpiresAt} IS NOT NULL
         AND ${JOB_COLUMNS.leaseExpiresAt} <= ?`,
    )
    .bind(
      exhausted ? 'FAILED' : 'PENDING',
      exhausted ? 1 : 0,
      LEASE_EXPIRED_ERROR,
      exhausted ? previous.runAt ?? null : runAt,
      exhausted ? 1 : 0,
      nowIso,
      nowIso,
      jobId,
      nowIso,
    )
    .run()
  if ((row.meta?.changes ?? 0) < 1) {
    return null
  }
  const next = await readStoredJob(payload, jobId)
  if (next) {
    await invokeJobChangeHooks(payload, previous, next)
    return next.status === 'FAILED' ? 'FAILED' : 'PENDING'
  }
  return exhausted ? 'FAILED' : 'PENDING'
}
