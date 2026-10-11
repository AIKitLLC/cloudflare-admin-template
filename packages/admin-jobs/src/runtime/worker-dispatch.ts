export const JOBS_WORKER_PATH = '/jobs-worker'
export const JOBS_INTERNAL_HOST = 'jobs.internal'
export const JOBS_INTERNAL_HEADER = 'x-jobs-internal'

export type WorkerDispatchKind = 'queue' | 'scheduled'

export type QueueDispatchResult = {
  action: 'ack' | 'retry'
}

type DispatchMessage = {
  ack: () => void
  retry: () => void
}

export function buildWorkerRequest(args: {
  kind: WorkerDispatchKind
  payload: unknown
  secret: string | undefined
}): Request {
  return new Request(`https://${JOBS_INTERNAL_HOST}${JOBS_WORKER_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [JOBS_INTERNAL_HEADER]: args.secret ?? '',
    },
    body: JSON.stringify({ kind: args.kind, payload: args.payload }),
  })
}

export function applyQueueResults(messages: DispatchMessage[], results: QueueDispatchResult[]): void {
  messages.forEach((message, index) => {
    if (results[index]?.action === 'retry') {
      message.retry()
      return
    }
    message.ack()
  })
}
