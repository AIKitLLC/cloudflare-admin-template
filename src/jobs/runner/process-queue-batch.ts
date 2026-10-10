import type { Payload } from 'payload'

import type { JobQueueMessage } from '../types'
import { processJob } from './process-job'

export type JobQueueMessageLike = {
  ack: () => void
  body: JobQueueMessage
  retry: () => void
}

export async function processQueueBatch(
  payload: Payload,
  batch: { messages: JobQueueMessageLike[] },
  now = new Date(),
): Promise<void> {
  for (const message of batch.messages) {
    const jobId = message.body?.jobId
    if (typeof jobId !== 'number' || !Number.isInteger(jobId)) {
      message.ack()
      continue
    }
    try {
      await processJob(payload, jobId, now)
      message.ack()
    } catch (error) {
      payload.logger.error({ err: error, jobId, msg: 'Job queue message failed before it was recorded.' })
      message.retry()
    }
  }
}
