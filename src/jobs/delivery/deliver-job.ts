import type { Payload } from 'payload'

import type { JobQueueMessage } from '../types'
import {
  isWorkerIsolate,
  readJobQueue,
  resolveDeliveryMode,
  shouldAutorun,
  type JobQueueBinding,
} from './delivery-mode'

const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

export async function deliverJob(
  payload: Payload,
  jobId: number | string,
  options?: { delayMs?: number; queue?: JobQueueBinding | null },
): Promise<void> {
  const queue = options?.queue === undefined ? await readJobQueue() : options.queue || undefined
  const mode = options?.queue ? 'queue' : resolveDeliveryMode(queue)
  if (mode === 'queue' && queue) {
    try {
      const delaySeconds = delaySecondsFor(options?.delayMs ?? 0)
      await queue.send(
        { jobId: Number(jobId) } satisfies JobQueueMessage,
        delaySeconds > 0 ? { delaySeconds } : undefined,
      )
      return
    } catch (error) {
      payload.logger.error({
        err: error,
        msg: 'Job queue send failed. The scheduled handler will pick the row up.',
      })
    }
  }
  if (shouldAutorun() && !isWorkerIsolate()) {
    scheduleInlineRun(payload, jobId, options?.delayMs ?? 0)
  }
}

function delaySecondsFor(delayMs: number): number {
  if (delayMs <= 0) {
    return 0
  }
  return Math.min(15 * 60, Math.max(1, Math.ceil(delayMs / 1000)))
}

export function scheduleInlineRun(payload: Payload, jobId: number | string, delayMs: number): void {
  const delay = Math.max(0, delayMs)
  const timer = setTimeout(() => {
    pendingTimers.delete(timer)
    void import('../runner/process-job')
      .then(({ processJob }) => processJob(payload, jobId))
      .catch((error: unknown) => {
        payload.logger.error({ err: error, msg: 'Inline job runner failed.' })
      })
  }, delay)
  timer.unref?.()
  pendingTimers.add(timer)
}

export function clearInlineRuns(): void {
  for (const timer of pendingTimers) {
    clearTimeout(timer)
  }
  pendingTimers.clear()
}
