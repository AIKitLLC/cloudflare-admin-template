import type { Payload } from 'payload'

import { deliverJob } from '../delivery/deliver-job'
import { reapExpiredLeases } from '../persistence/reap-expired-leases'
import { selectDueJobIds } from '../persistence/select-job-ids'

export async function runScheduledMaintenance(
  payload: Payload,
  now = new Date(),
): Promise<{ delivered: number; failed: number; requeued: number }> {
  const reaped = await reapExpiredLeases(payload, now)
  const due = await selectDueJobIds(payload, now)
  for (const jobId of due) {
    await deliverJob(payload, jobId)
  }
  return { delivered: due.length, failed: reaped.failed, requeued: reaped.requeued }
}
