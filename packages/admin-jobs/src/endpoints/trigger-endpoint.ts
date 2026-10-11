import type { Endpoint, PayloadRequest } from 'payload'

import { enqueueRegisteredJob } from '../delivery/enqueue-registered-job'
import { endpointErrorResponse } from './endpoint-error-response'

export const triggerJobEndpoint: Endpoint = {
  path: '/trigger',
  method: 'post',
  handler: async (req) => {
    try {
      const body = (await readJson(req)) ?? {}
      const result = await enqueueRegisteredJob({
        req,
        name: body.name,
        payload: body.payload,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      })
      return Response.json(
        {
          created: result.created,
          doc: result.job,
        },
        { status: result.created ? 201 : 200 },
      )
    } catch (error) {
      return endpointErrorResponse(error)
    }
  },
}

async function readJson(req: PayloadRequest): Promise<{
  idempotencyKey?: unknown
  name?: unknown
  payload?: unknown
} | null> {
  if (typeof req.json !== 'function') {
    return null
  }
  return (await req.json()) as {
    idempotencyKey?: unknown
    name?: unknown
    payload?: unknown
  }
}
