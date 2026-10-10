import type { PayloadRequest, Where } from 'payload'

import { USERS_SLUG } from '../../access/constants'
import { relationIds } from '../../access/relation-id'
import { fullAccessRoleIds } from '../../rbac/guards/full-access-role-ids'
import { readVisibleUsersPromise, storeVisibleUsersPromise } from '../cache/scope-request-cache'
import {
  SCOPE_PATH_FIELD,
  USER_BRANCHES_FIELD,
  USER_DATA_CLASSES_FIELD,
  USER_ORGANIZATIONS_FIELD,
  VISIBLE_USERS_CACHE_KEY,
} from '../constants'
import { findEveryPage } from '../find/find-every-page'
import { assignmentsWithinScope } from '../guards/assignments-within-scope'
import { loadEffectiveScope } from '../resolve/load-effective-scope'
import { loadScopeAssignments } from '../resolve/load-scope-assignments'
import { whereIdIn } from './where-id-in'
import { wherePathContains } from './where-path-contains'

type UserRow = {
  id: number | string
  roles?: unknown
  organizations?: unknown
  branches?: unknown
  dataClasses?: unknown
}

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

/**
 * Users are filtered by their scope relationships, then reduced to accounts whose
 * assignments are entirely inside the actor's scope. Full-access accounts are removed.
 * Unscoped accounts are absent unless the row is the actor. The resulting id list is
 * the document id, which D1 writes as SQL literals rather than bound parameters.
 */
async function visibleUserWhere(req: PayloadRequest, actorId: string): Promise<Where> {
  const [assignments, scope, privilegedRoles] = await Promise.all([
    loadScopeAssignments(req),
    loadEffectiveScope(req),
    fullAccessRoleIds(req),
  ])
  const ids = new Set<string>()
  if (actorId) {
    ids.add(actorId)
  }
  const overlap = overlapWhere(assignments)
  if (overlap) {
    const users = await findEveryPage<UserRow>(req, USERS_SLUG, overlap)
    for (const user of users) {
      if (relationIds(user.roles).some((roleId) => privilegedRoles.has(roleId))) {
        continue
      }
      if (!assignmentsWithinScope(user, scope)) {
        continue
      }
      ids.add(String(user.id))
    }
  }
  return whereIdIn('id', ids)
}

function overlapWhere(assignments: {
  organizationIds: string[]
  branchIds: string[]
  dataClassIds: string[]
}): Where | undefined {
  const parts = [
    wherePathContains(
      `${USER_ORGANIZATIONS_FIELD}.${SCOPE_PATH_FIELD}`,
      assignments.organizationIds,
    ),
    wherePathContains(`${USER_BRANCHES_FIELD}.${SCOPE_PATH_FIELD}`, assignments.branchIds),
    wherePathContains(
      `${USER_BRANCHES_FIELD}.organization.${SCOPE_PATH_FIELD}`,
      assignments.organizationIds,
    ),
    wherePathContains(`${USER_DATA_CLASSES_FIELD}.${SCOPE_PATH_FIELD}`, assignments.dataClassIds),
  ].filter((part): part is Where => part !== undefined)
  if (parts.length === 0) {
    return undefined
  }
  if (parts.length === 1) {
    return parts[0]
  }
  return { or: parts }
}
