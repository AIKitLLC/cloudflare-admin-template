import type { Payload } from 'payload'

import { runScheduledMaintenance } from '../runner/run-scheduled-maintenance'

export async function handleScheduled(payload: Payload): Promise<void> {
  await runScheduledMaintenance(payload)
}
