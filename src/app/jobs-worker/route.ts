import { getCloudflareContext } from '@opennextjs/cloudflare'

import { handleQueueBatch } from '@/jobs/runtime/handle-queue-batch'
import { handleScheduled } from '@/jobs/runtime/handle-scheduled'
import {
  JOBS_INTERNAL_HEADER,
  JOBS_INTERNAL_HOST,
  JOBS_WORKER_PATH,
} from '@/jobs/runtime/worker-dispatch'

export const dynamic = 'force-dynamic'

type QueueBody = {
  messages?: Array<{ body: { jobId?: unknown } }>
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.hostname !== JOBS_INTERNAL_HOST || url.pathname !== JOBS_WORKER_PATH) {
    return new Response(null, { status: 404 })
  }
  const secret = await readInternalSecret()
  if (!secret || request.headers.get(JOBS_INTERNAL_HEADER) !== secret) {
    return new Response(null, { status: 404 })
  }
  const body = (await request.json()) as { kind?: string; payload?: unknown }
  if (body.kind === 'queue') {
    const messages = queueMessages(body.payload)
    const results = await handleQueueBatch({ messages })
    return Response.json({ results })
  }
  if (body.kind === 'scheduled') {
    await handleScheduled()
    return Response.json({ ok: true })
  }
  return new Response(null, { status: 404 })
}

function queueMessages(payload: unknown) {
  const messages = (payload as QueueBody | null)?.messages ?? []
  return messages.map((message) => ({
    body: message.body,
    ack() {},
    retry() {
      this.retried = true
    },
    retried: false,
  }))
}

async function readInternalSecret(): Promise<string | undefined> {
  if (process.env.JOBS_INTERNAL_SECRET) {
    return process.env.JOBS_INTERNAL_SECRET
  }
  try {
    const context = await getCloudflareContext({ async: true })
    const value = (context.env as unknown as Record<string, unknown>).JOBS_INTERNAL_SECRET
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}
