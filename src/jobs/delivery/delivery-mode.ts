import { getCloudflareContext } from '@opennextjs/cloudflare'

import { JOB_QUEUE_BINDING } from '../constants'
import type { JobQueueMessage } from '../types'

export type JobQueueBinding = {
  send: (message: JobQueueMessage, options?: { delaySeconds?: number }) => Promise<void>
}

export function isWorkerIsolate(): boolean {
  return typeof navigator !== 'undefined' && /Cloudflare-Workers/i.test(navigator.userAgent)
}

export async function readJobQueue(): Promise<JobQueueBinding | undefined> {
  try {
    const context = await getCloudflareContext({ async: true })
    const queue = (context.env as unknown as Record<string, unknown>)[JOB_QUEUE_BINDING]
    if (queue && typeof queue === 'object' && typeof (queue as JobQueueBinding).send === 'function') {
      return queue as JobQueueBinding
    }
  } catch {
    return undefined
  }
  return undefined
}

export function resolveDeliveryMode(queue: JobQueueBinding | undefined): 'inline' | 'queue' {
  if (process.env.JOBS_DELIVERY === 'inline') {
    return 'inline'
  }
  if (process.env.JOBS_DELIVERY === 'queue') {
    return queue ? 'queue' : 'inline'
  }
  if (process.env.NODE_ENV !== 'production') {
    return 'inline'
  }
  return queue ? 'queue' : 'inline'
}

export function shouldAutorun(): boolean {
  if (process.env.JOBS_AUTORUN === '0') {
    return false
  }
  if (process.env.JOBS_AUTORUN === '1') {
    return true
  }
  return process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test'
}
