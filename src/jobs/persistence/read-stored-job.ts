import type { Payload } from 'payload'

import { JOBS_SLUG } from '../constants'
import type { StoredJob } from '../types'

export async function readStoredJob(
  payload: Payload,
  id: number | string,
): Promise<StoredJob | null> {
  const doc = await payload
    .findByID({
      collection: JOBS_SLUG,
      id,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })
    .catch((): null => null)
  if (!doc) {
    return null
  }
  return doc as StoredJob
}
