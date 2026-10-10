import type { Payload } from 'payload'

import { SCHEDULED_D1_BUDGET, SCHEDULED_RUN_LIMIT } from '../constants'
import { createD1Budget } from '../persistence/d1-client'
import { reapExpiredLeases } from '../persistence/reap-expired-leases'
import { selectDueJobIds } from '../persistence/select-job-ids'
import { processJob } from './process-job'

const RESERVED_CALLS_PER_JOB = 12

export async function runScheduledMaintenance(
  payload: Payload,
  now = new Date(),
): Promise<{ d1Calls: number; failed: number; ran: number; requeued: number }> {
  const budget = createD1Budget(SCHEDULED_D1_BUDGET)
  const reaped = await reapExpiredLeases(payload, now, budget)
  const due = await selectDueJobIds(payload, now, budget)
  let ran = 0
  for (const jobId of due) {
    if (ran >= SCHEDULED_RUN_LIMIT) {
      break
    }
    if (budget.used() > SCHEDULED_D1_BUDGET - RESERVED_CALLS_PER_JOB) {
      break
    }
    await processJob(payload, jobId, now, budget)
    ran += 1
  }
  return { d1Calls: budget.used(), failed: reaped.failed, ran, requeued: reaped.requeued }
}
