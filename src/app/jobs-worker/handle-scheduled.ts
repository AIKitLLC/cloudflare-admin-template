import { getPayload, type Payload } from 'payload'

import config from '../../payload.config'
import { runScheduledMaintenance } from '@/jobs'

let payloadPromise: Promise<Payload> | undefined

export async function handleScheduled(): Promise<void> {
  const payload = await getJobPayload()
  await runScheduledMaintenance(payload)
}

async function getJobPayload(): Promise<Payload> {
  payloadPromise ??= getPayload({ config })
  return payloadPromise
}
