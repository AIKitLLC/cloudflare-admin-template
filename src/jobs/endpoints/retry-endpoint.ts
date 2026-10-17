import type { Endpoint } from 'payload'

import { retryFailedJob } from '../delivery/retry-failed-job'
import { endpointErrorResponse } from './endpoint-error-response'

export const retryJobEndpoint: Endpoint = {
  path: '/:id/retry',
  method: 'post',
  handler: async (req) => {
    try {
      const id = req.routeParams?.id
      if (typeof id !== 'string' && typeof id !== 'number') {
        return Response.json({ errors: [{ message: 'Job id is required.' }] }, { status: 400 })
      }
      const job = await retryFailedJob({ req, id })
      return Response.json({ doc: job })
    } catch (error) {
      return endpointErrorResponse(error)
    }
  },
}
