import { getPayload, type Payload } from 'payload'

import config from '../../payload.config'
import { processQueueBatch, type JobQueueMessageLike } from '@/jobs'

type QueueBatch = {
  messages: Array<JobQueueMessageLike & { retried?: boolean }>
}

let payloadPromise: Promise<Payload> | undefined

export async function handleQueueBatch(batch: QueueBatch): Promise<Array<{ action: 'ack' | 'retry' }>> {
  const payload = await getJobPayload()
  await processQueueBatch(payload, batch)
  return batch.messages.map((message) => ({
    action: message.retried ? 'retry' : 'ack',
  }))
}

async function getJobPayload(): Promise<Payload> {
  payloadPromise ??= getPayload({ config })
  return payloadPromise
}
