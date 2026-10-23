import type { CollectionSlug, PayloadRequest } from 'payload'

import { USERS_SLUG } from '../../access'
import { assignmentsFromRecord, emptyAssignments } from './assignments-from-record'
import type { ScopeAssignments } from '../types'

export async function loadScopeAssignments(req: PayloadRequest): Promise<ScopeAssignments> {
  const userId = req.user?.id
  if (userId === undefined || userId === null) {
    return emptyAssignments()
  }
  const user = await req.payload.findByID({
    collection: USERS_SLUG as CollectionSlug,
    id: userId,
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })
  if (!user) {
    return emptyAssignments()
  }
  return assignmentsFromRecord(user)
}
