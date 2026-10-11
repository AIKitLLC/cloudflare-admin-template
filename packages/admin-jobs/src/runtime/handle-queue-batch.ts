import type { Payload } from 'payload'

import { processQueueBatch, type JobQueueMessageLike } from '../runner/process-queue-batch'

type QueueBatch = {
  messages: Array<JobQueueMessageLike & { retried?: boolean }>
}

export async function handleQueueBatch(
  payload: Payload,
  batch: QueueBatch,
): Promise<Array<{ action: 'ack' | 'retry' }>> {
  await processQueueBatch(payload, batch)
  return batch.messages.map((message) => ({
    action: message.retried ? 'retry' : 'ack',
  }))
}
