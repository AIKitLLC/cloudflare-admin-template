import type { Payload } from 'payload'

import { JOB_HANDLER_READ, JOBS_SLUG } from '../constants'
import type { StoredJob } from '../types'

export async function readStoredJob(
  payload: Payload,
  id: number | string,
  options?: { raw?: boolean },
): Promise<StoredJob | null> {
  const doc = await payload
    .findByID({
      collection: JOBS_SLUG,
      id,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
      context: options?.raw ? { [JOB_HANDLER_READ]: true } : undefined,
    })
    .catch((): null => null)
  if (!doc) {
    return null
  }
  return doc as StoredJob
}
