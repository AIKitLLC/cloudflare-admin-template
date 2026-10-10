import type { Payload } from 'payload'

import { MAINTENANCE_BATCH } from '../constants'
import { d1 } from './d1-client'
import { JOB_COLUMNS, JOBS_TABLE } from './job-columns'

export async function selectDueJobIds(payload: Payload, now: Date): Promise<number[]> {
  const result = await d1(payload)
    .prepare(
      `SELECT ${JOB_COLUMNS.id} as id
       FROM ${JOBS_TABLE}
       WHERE ${JOB_COLUMNS.status} = 'PENDING'
         AND (${JOB_COLUMNS.runAt} IS NULL OR ${JOB_COLUMNS.runAt} <= ?)
       ORDER BY ${JOB_COLUMNS.runAt} ASC
       LIMIT ?`,
    )
    .bind(now.toISOString(), MAINTENANCE_BATCH)
    .all<{ id: number }>()
  return (result.results ?? []).map((row) => Number(row.id))
}

export async function selectExpiredLeaseIds(payload: Payload, now: Date): Promise<number[]> {
  const result = await d1(payload)
    .prepare(
      `SELECT ${JOB_COLUMNS.id} as id
       FROM ${JOBS_TABLE}
       WHERE ${JOB_COLUMNS.status} = 'RUNNING'
         AND ${JOB_COLUMNS.leaseExpiresAt} IS NOT NULL
         AND ${JOB_COLUMNS.leaseExpiresAt} <= ?
       ORDER BY ${JOB_COLUMNS.leaseExpiresAt} ASC
       LIMIT ?`,
    )
    .bind(now.toISOString(), MAINTENANCE_BATCH)
    .all<{ id: number }>()
  return (result.results ?? []).map((row) => Number(row.id))
}
