import type {
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionSlug,
} from 'payload'
import { APIError } from 'payload'

import { USERS_SLUG } from '../../access/constants'
import { userGrantsFullAccess } from '../../access/resolve/load-user-grants'
import { relationIds } from '../../access/relation-id'
import { fullAccessRoleIds } from './full-access-role-ids'
import { changedRoleIds, roleIdList, sameRoleIds } from './role-id-set'
import { FULL_ACCESS_ASSIGNMENT_ERROR, LAST_FULL_ACCESS_ERROR } from './privilege-errors'
import { skipsPrivilegeChecks } from './privilege-context'

export const guardUserRoleAssignment: CollectionBeforeChangeHook = async ({
  context,
  data,
  originalDoc,
  req,
}) => {
  if (skipsPrivilegeChecks(context) || !req.user || !data) {
    return data
  }

  const previous = roleIdList(originalDoc?.roles)
  const next = data.roles === undefined ? previous : roleIdList(data.roles)
  if (sameRoleIds(previous, next)) {
    return data
  }

  const privilegedRoles = await fullAccessRoleIds(req)
  const touchesPrivilegedRole = changedRoleIds(previous, next).some((id) => privilegedRoles.has(id))
  if (touchesPrivilegedRole && !(await userGrantsFullAccess(req))) {
    throw new APIError(FULL_ACCESS_ASSIGNMENT_ERROR, 403)
  }

  const keptPrivilegedRole = next.some((id) => privilegedRoles.has(id))
  const hadPrivilegedRole = previous.some((id) => privilegedRoles.has(id))
  if (hadPrivilegedRole && !keptPrivilegedRole) {
    await assertAnotherFullAccessUser(req, originalDoc?.id, privilegedRoles)
  }
  return data
}

export const guardLastFullAccessDeletion: CollectionBeforeDeleteHook = async ({
  context,
  id,
  req,
}) => {
  if (skipsPrivilegeChecks(context) || !req.user) {
    return
  }
  const user = (await req.payload.findByID({
    collection: USERS_SLUG,
    id,
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })) as { roles?: unknown } | null
  const assigned = relationIds(user?.roles)
  const privilegedRoles = await fullAccessRoleIds(req)
  if (!assigned.some((roleId) => privilegedRoles.has(roleId))) {
    return
  }
  if (!(await userGrantsFullAccess(req))) {
    throw new APIError(FULL_ACCESS_ASSIGNMENT_ERROR, 403)
  }
  await assertAnotherFullAccessUser(req, id, privilegedRoles)
}

async function assertAnotherFullAccessUser(
  req: Parameters<CollectionBeforeChangeHook>[0]['req'],
  userId: unknown,
  privilegedRoles: Set<string>,
): Promise<void> {
  if (privilegedRoles.size === 0) {
    throw new APIError(LAST_FULL_ACCESS_ERROR, 403)
  }
  const others = await req.payload.count({
    collection: USERS_SLUG as CollectionSlug,
    overrideAccess: true,
    req,
    where: {
      and: [{ id: { not_equals: userId } }, { roles: { in: [...privilegedRoles] } }],
    },
  })
  if (others.totalDocs === 0) {
    throw new APIError(LAST_FULL_ACCESS_ERROR, 403)
  }
}
