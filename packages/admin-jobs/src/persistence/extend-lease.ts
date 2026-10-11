import type { Payload } from 'payload'

import { d1, type D1Budget } from './d1-client'
import { JOB_COLUMNS, JOBS_TABLE } from './job-columns'

export async function extendLease(
  payload: Payload,
  jobId: number | string,
  claimToken: string,
  leaseMs: number,
  now = new Date(),
  budget?: D1Budget,
): Promise<boolean> {
  const nextLease = new Date(now.getTime() + leaseMs).toISOString()
  const row = await d1(payload, budget)
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
