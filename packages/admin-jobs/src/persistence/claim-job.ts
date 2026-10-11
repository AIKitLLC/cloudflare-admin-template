import { randomUUID } from 'crypto'
import type { Payload } from 'payload'

import { DEFAULT_LEASE_MS } from '../constants'
import { getJob } from '../registry/job-registry'
import { d1, type D1Budget } from './d1-client'
import { invokeJobChangeHooks } from './invoke-job-hooks'
import { JOB_COLUMNS, JOBS_TABLE } from './job-columns'
import { readStoredJob } from './read-stored-job'

export type ClaimResult = {
  attempt: number
  claimToken: string
}

export async function claimJob(
  payload: Payload,
  jobId: number | string,
  now = new Date(),
  budget?: D1Budget,
): Promise<ClaimResult | null> {
  const existing = await readStoredJob(payload, jobId, { budget })
  if (!existing) {
    return null
  }
  const definition = getJob(existing.name)
  const leaseMs = definition?.leaseMs ?? DEFAULT_LEASE_MS
  const nowIso = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString()
  const claimToken = randomUUID()
  const row = await d1(payload, budget)
    .prepare(
      `UPDATE ${JOBS_TABLE}
       SET ${JOB_COLUMNS.claimToken} = ?,
           ${JOB_COLUMNS.leaseExpiresAt} = ?,
           ${JOB_COLUMNS.status} = 'RUNNING',
           ${JOB_COLUMNS.attempt} = ${JOB_COLUMNS.attempt} + 1,
           ${JOB_COLUMNS.startedAt} = ?,
           ${JOB_COLUMNS.updatedAt} = ?
       WHERE ${JOB_COLUMNS.id} = ?
         AND ${JOB_COLUMNS.attempt} < ${JOB_COLUMNS.maxAttempts}
         AND (
           (${JOB_COLUMNS.status} = 'PENDING' AND (${JOB_COLUMNS.runAt} IS NULL OR ${JOB_COLUMNS.runAt} <= ?))
           OR (
             ${JOB_COLUMNS.status} = 'RUNNING'
             AND ${JOB_COLUMNS.leaseExpiresAt} IS NOT NULL
             AND ${JOB_COLUMNS.leaseExpiresAt} <= ?
           )
         )
       RETURNING ${JOB_COLUMNS.id} as id, ${JOB_COLUMNS.attempt} as attempt`,
    )
    .bind(claimToken, leaseExpiresAt, nowIso, nowIso, jobId, nowIso, nowIso)
    .first<{ attempt: number; id: number }>()
  if (!row) {
    return null
  }
  const next = await readStoredJob(payload, jobId, { budget })
  if (next) {
    await invokeJobChangeHooks(payload, existing, next)
  }
  return { attempt: Number(row.attempt), claimToken }
}
