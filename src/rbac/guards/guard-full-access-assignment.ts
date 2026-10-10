import type {
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionSlug,
  PayloadRequest,
} from 'payload'
import { APIError } from 'payload'

import { USERS_SLUG } from '../../access/constants'
import { loadUserGrants, userGrantsFullAccess } from '../../access/resolve/load-user-grants'
import { relationIds } from '../../access/relation-id'
import { fullAccessRoleIds } from './full-access-role-ids'
import { addedRoleIds, changedRoleIds, roleIdList, sameRoleIds } from './role-id-set'
import {
  FULL_ACCESS_ASSIGNMENT_ERROR,
  LAST_FULL_ACCESS_ERROR,
  SUBSET_ASSIGNMENT_ERROR,
} from './privilege-errors'
import { skipsPrivilegeChecks } from './privilege-context'
import { grantedKeysByRole } from './role-permission-keys'

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
  if (!(await userGrantsFullAccess(req))) {
    await assertAddedRolesAreSubset(req, addedRoleIds(previous, next))
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

export async function assertRemainingFullAccessHolder(
  req: PayloadRequest,
  excludedRoleId: string,
): Promise<void> {
  const privilegedRoles = await fullAccessRoleIds(req)
  privilegedRoles.delete(excludedRoleId)
  if (privilegedRoles.size === 0) {
    throw new APIError(LAST_FULL_ACCESS_ERROR, 403)
  }
  const holders = await req.payload.count({
    collection: USERS_SLUG as CollectionSlug,
    overrideAccess: true,
    req,
    where: {
      roles: {
        in: [...privilegedRoles],
      },
    },
  })
  if (holders.totalDocs === 0) {
    throw new APIError(LAST_FULL_ACCESS_ERROR, 403)
  }
}

async function assertAddedRolesAreSubset(req: PayloadRequest, roleIds: string[]): Promise<void> {
  if (roleIds.length === 0) {
    return
  }
  const [grants, keysByRole] = await Promise.all([
    loadUserGrants(req),
    grantedKeysByRole(req, roleIds),
  ])
  for (const roleId of roleIds) {
    for (const key of keysByRole.get(roleId) ?? []) {
      if (!grants?.permissionKeys.has(key)) {
        throw new APIError(SUBSET_ASSIGNMENT_ERROR, 403)
      }
    }
  }
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
