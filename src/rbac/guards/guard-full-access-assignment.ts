import type {
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionBeforeOperationHook,
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
  PRIVILEGED_USER_ERROR,
  SUBSET_ASSIGNMENT_ERROR,
} from './privilege-errors'
import { assertUserWithinActorScope } from '../../scope/guards/assert-user-within-actor-scope'
import { skipsPrivilegeChecks } from './privilege-context'
import { grantedKeysByRole } from './role-permission-keys'

export const guardUserRoleAssignment: CollectionBeforeChangeHook = async ({
  context,
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (operation !== 'create') {
    await assertMayMutateUser({ context, req, target: originalDoc, targetId: originalDoc?.id })
  }
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

export const guardAuthCredentialOperation: CollectionBeforeOperationHook = async ({
  args,
  operation,
  req,
}) => {
  if (operation !== 'forgotPassword' && operation !== 'resetPassword' && operation !== 'unlock') {
    return args
  }
  if (skipsPrivilegeChecks(req.context) || !req.user) {
    return args
  }
  const data = (args as { data?: { email?: unknown; token?: unknown } }).data
  const target =
    operation === 'resetPassword'
      ? await findUser(req, tokenWhere(data?.token))
      : await findUser(req, emailWhere(data?.email))
  await assertMayMutateUser({
    context: req.context,
    req,
    target,
    targetId: target?.id,
  })
  await assertUserWithinActorScope(req, target)
  return args
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
  })) as { id?: number | string; roles?: unknown } | null
  await assertMayMutateUser({ context, req, target: user, targetId: id })
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

async function assertMayMutateUser(args: {
  context: unknown
  req: PayloadRequest
  target: { roles?: unknown } | null | undefined
  targetId: unknown
}): Promise<void> {
  if (skipsPrivilegeChecks(args.context) || !args.req.user || args.targetId == null) {
    return
  }
  if (isSelf(args.req, args.targetId)) {
    return
  }
  if (await userGrantsFullAccess(args.req)) {
    return
  }
  const roleIds = relationIds(args.target?.roles)
  const privilegedRoles = await fullAccessRoleIds(args.req)
  if (roleIds.some((roleId) => privilegedRoles.has(roleId))) {
    throw new APIError(PRIVILEGED_USER_ERROR, 403)
  }
  const [actor, keysByRole] = await Promise.all([
    loadUserGrants(args.req),
    grantedKeysByRole(args.req, roleIds),
  ])
  for (const roleId of roleIds) {
    for (const key of keysByRole.get(roleId) ?? []) {
      if (!actor?.permissionKeys.has(key)) {
        throw new APIError(PRIVILEGED_USER_ERROR, 403)
      }
    }
  }
}

function isSelf(req: PayloadRequest, targetId: unknown): boolean {
  return String(req.user?.id) === String(targetId)
}

function emailWhere(email: unknown): Record<string, { equals: string }> | undefined {
  if (typeof email !== 'string' || email.trim() === '') {
    return undefined
  }
  return { email: { equals: email.trim().toLowerCase() } }
}

function tokenWhere(token: unknown): Record<string, { equals: string }> | undefined {
  if (typeof token !== 'string' || token.trim() === '') {
    return undefined
  }
  return { resetPasswordToken: { equals: token } }
}

async function findUser(
  req: PayloadRequest,
  where: Record<string, { equals: string }> | undefined,
): Promise<{ id: number | string; roles?: unknown } | null> {
  if (!where) {
    return null
  }
  const found = await req.payload.find({
    collection: USERS_SLUG,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where,
  })
  return (found.docs[0] as { id: number | string; roles?: unknown } | undefined) ?? null
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
