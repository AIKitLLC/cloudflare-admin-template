import type {
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionSlug,
  PayloadRequest,
} from 'payload'
import { APIError } from 'payload'

import { ROLE_PERMISSIONS_SLUG } from '../../access/constants'
import { loadUserGrants } from '../../access/resolve/load-user-grants'
import { relationId } from '../../access/relation-id'
import { OWN_ROLE_GRANT_ERROR } from './privilege-errors'
import { skipsPrivilegeChecks } from './privilege-context'

export async function assertMayChangeRoleGrant(args: {
  context?: unknown
  req: PayloadRequest
  roleId: number | string
}): Promise<void> {
  if (skipsPrivilegeChecks(args.context) || !args.req.user) {
    return
  }
  const grants = await loadUserGrants(args.req)
  if (grants?.fullAccess) {
    return
  }
  if (grants?.roleIds.includes(String(args.roleId))) {
    throw new APIError(OWN_ROLE_GRANT_ERROR, 403)
  }
}

export const guardRolePermissionWrite: CollectionBeforeChangeHook = async ({
  context,
  data,
  originalDoc,
  req,
}) => {
  const roleIds = [relationId(data?.role), relationId(originalDoc?.role)].filter(
    (id): id is string => Boolean(id),
  )
  for (const roleId of roleIds) {
    await assertMayChangeRoleGrant({ context, req, roleId })
  }
  return data
}

export const guardRolePermissionDelete: CollectionBeforeDeleteHook = async ({
  context,
  id,
  req,
}) => {
  const grant = (await req.payload.findByID({
    collection: ROLE_PERMISSIONS_SLUG as CollectionSlug,
    id,
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })) as { role?: unknown } | null
  const roleId = relationId(grant?.role)
  if (!roleId) {
    return
  }
  await assertMayChangeRoleGrant({ context, req, roleId })
}
