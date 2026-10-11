import type { PayloadRequest } from 'payload'

import { JOB_RETRY_WRITE, JOBS_SLUG } from '../constants'
import {
  JOB_NOT_FOUND_MESSAGE,
  JOB_PRIVILEGE_MESSAGE,
  RETRY_FORBIDDEN_MESSAGE,
  RETRY_ONLY_FAILED_MESSAGE,
  jobError,
} from '../errors'
import { evaluateJobDispatch } from '../auth/evaluate-job-dispatch'
import { evaluateJobTrigger } from '../auth/evaluate-job-trigger'
import type { StoredJob } from '../types'

export async function retryFailedJob(args: {
  id: number | string
  req: PayloadRequest
}): Promise<StoredJob> {
  if (!(await evaluateJobDispatch(args.req, 'retry'))) {
    throw jobError(RETRY_FORBIDDEN_MESSAGE, 403)
  }
  const existing = await args.req.payload
    .findByID({
      collection: JOBS_SLUG,
      id: args.id,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
      req: args.req,
    })
    .catch((): null => null)
  if (!existing) {
    throw jobError(JOB_NOT_FOUND_MESSAGE, 404)
  }
  if ((existing as StoredJob).status !== 'FAILED') {
    throw jobError(RETRY_ONLY_FAILED_MESSAGE)
  }
  if (!(await evaluateJobTrigger(args.req, (existing as StoredJob).name))) {
    throw jobError(JOB_PRIVILEGE_MESSAGE, 403)
  }
  const updated = await args.req.payload.update({
    collection: JOBS_SLUG,
    id: args.id,
    data: {
      attempt: 0,
      claimToken: null,
      error: (existing as StoredJob).error,
      finishedAt: null,
      leaseExpiresAt: null,
      runAt: null,
      status: 'PENDING',
    },
    overrideAccess: true,
    req: args.req,
    context: {
      [JOB_RETRY_WRITE]: true,
    },
  })
  return updated as StoredJob
}
