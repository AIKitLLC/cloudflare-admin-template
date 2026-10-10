import { getPayload, type Payload } from 'payload'

import config from '../../payload.config'
import type { JobQueueMessage } from '../types'
import { processQueueBatch, type JobQueueMessageLike } from '../runner/process-queue-batch'

type QueueBatch = {
  messages: Array<JobQueueMessageLike & { body: JobQueueMessage }>
}

let payloadPromise: Promise<Payload> | undefined

export async function handleQueueBatch(batch: QueueBatch): Promise<void> {
  const payload = await getJobPayload()
  await processQueueBatch(payload, batch)
}

async function getJobPayload(): Promise<Payload> {
  payloadPromise ??= getPayload({ config })
  return payloadPromise
}
