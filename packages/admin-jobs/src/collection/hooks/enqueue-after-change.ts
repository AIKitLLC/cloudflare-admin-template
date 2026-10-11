import type { CollectionAfterChangeHook } from 'payload'

import { SKIP_JOB_ENQUEUE } from '../../constants'
import { deliverJob } from '../../delivery/deliver-job'
import type { StoredJob } from '../../types'

export const enqueueAfterChange: CollectionAfterChangeHook = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (req.context?.[SKIP_JOB_ENQUEUE] === true) {
    return doc
  }
  const job = doc as StoredJob
  const previous = previousDoc as StoredJob | undefined
  const becamePending =
    operation === 'create' || (operation === 'update' && previous?.status === 'FAILED')
  if (becamePending && job.status === 'PENDING') {
    await deliverJob(req.payload, job.id)
  }
  return doc
}
