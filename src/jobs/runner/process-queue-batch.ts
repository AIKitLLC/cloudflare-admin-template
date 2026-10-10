import type { Payload } from 'payload'

import { processJob } from './process-job'

export type JobQueueMessageLike = {
  ack: () => void
  body: { jobId?: unknown }
  retried?: boolean
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
      payload.logger.error({
        jobId,
        msg: 'Job queue message had a non-integer jobId and was acknowledged.',
      })
      message.ack()
      continue
    }
    try {
      await processJob(payload, jobId, now)
      message.ack()
    } catch (error) {
      payload.logger.error({ err: error, jobId, msg: 'Job queue message failed before it was recorded.' })
      message.retried = true
      message.retry()
    }
  }
}
