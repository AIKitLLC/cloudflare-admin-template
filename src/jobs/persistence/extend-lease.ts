import type { Payload } from 'payload'

import { DEFAULT_LEASE_MS } from '../constants'
import { getJob } from '../registry/job-registry'
import { d1 } from './d1-client'
import { JOB_COLUMNS, JOBS_TABLE } from './job-columns'
import { readStoredJob } from './read-stored-job'

export async function extendLease(
  payload: Payload,
  jobId: number | string,
  claimToken: string,
  now = new Date(),
): Promise<boolean> {
  const job = await readStoredJob(payload, jobId)
  if (!job) {
    return false
  }
  const leaseMs = getJob(job.name)?.leaseMs ?? DEFAULT_LEASE_MS
  const nextLease = new Date(now.getTime() + leaseMs).toISOString()
  const row = await d1(payload)
    .prepare(
      `UPDATE ${JOBS_TABLE}
       SET ${JOB_COLUMNS.leaseExpiresAt} = ?,
           ${JOB_COLUMNS.updatedAt} = ?
       WHERE ${JOB_COLUMNS.id} = ?
         AND ${JOB_COLUMNS.claimToken} = ?
         AND ${JOB_COLUMNS.status} = 'RUNNING'`,
    )
    .bind(nextLease, now.toISOString(), jobId, claimToken)
    .run()
  return (row.meta?.changes ?? 0) > 0
}
