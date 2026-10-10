import type { PayloadRequest, Where } from 'payload'

import { USERS_SLUG } from '../../access/constants'
import { readVisibleUsersPromise, storeVisibleUsersPromise } from '../cache/scope-request-cache'
import { VISIBLE_USERS_CACHE_KEY } from '../constants'
import { assignmentsWithinScope } from '../guards/assignments-within-scope'
import { loadEffectiveScope } from '../resolve/load-effective-scope'
import { whereIdIn } from './where-id-in'

export async function whereUsersWithinScope(req: PayloadRequest): Promise<Where> {
  const userId = String(req.user?.id ?? '')
  const cached = readVisibleUsersPromise(req, userId)
  if (cached) {
    return cached
  }
  const pending = visibleUserWhere(req, userId)
  storeVisibleUsersPromise(req, userId, pending)
  try {
    return await pending
  } catch (error) {
    if (req.context) {
      delete req.context[VISIBLE_USERS_CACHE_KEY]
    }
    throw error
  }
}

async function visibleUserWhere(req: PayloadRequest, actorId: string): Promise<Where> {
  const scope = await loadEffectiveScope(req)
  const users = await req.payload.find({
    collection: USERS_SLUG,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
  })
  const ids = new Set<string>()
  for (const user of users.docs) {
    if (assignmentsWithinScope(user, scope)) {
      ids.add(String(user.id))
    }
  }
  if (actorId) {
    ids.add(actorId)
  }
  return whereIdIn('id', ids)
}
