import type {
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionSlug,
  PayloadRequest,
} from 'payload'
import { APIError } from 'payload'

import { ROLE_PERMISSIONS_SLUG } from '../../access'
import { loadUserGrants } from '../../access'
import { relationId } from '../../access'
import { assertRoleHoldersWithinActorScope } from '../../scope'
import { OWN_ROLE_GRANT_ERROR, SUBSET_GRANT_ERROR } from './privilege-errors'
import { permissionKeysForIds, skipsPrivilegeChecks } from '../../access'

export async function assertMayChangeRoleGrant(args: {
  context?: unknown
  granted?: boolean
  permissionIds?: Array<number | string>
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
  const permissionIds = (args.permissionIds ?? [])
    .map((id) => String(id))
    .filter((id) => id.length > 0)
  if (permissionIds.length === 0) {
    return
  }
  const keys = await permissionKeysForIds(args.req, permissionIds)
  for (const permissionId of permissionIds) {
    const key = keys.get(permissionId)
    if (!key || !grants?.permissionKeys.has(key)) {
      throw new APIError(SUBSET_GRANT_ERROR, 403)
    }
  }
  if (args.granted === true) {
    await assertRoleHoldersWithinActorScope({ req: args.req, roleId: args.roleId })
  }
}

export const guardRolePermissionWrite: CollectionBeforeChangeHook = async ({
  context,
  data,
  originalDoc,
  req,
}) => {
  const roleIds = [
    ...new Set(
      [relationId(data?.role), relationId(originalDoc?.role)].filter((id): id is string =>
        Boolean(id),
      ),
    ),
  ]
  const permissionIds = [
    ...new Set(
      [relationId(data?.permission), relationId(originalDoc?.permission)].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ]
  const granted = grantedAfterWrite(data, originalDoc)
  for (const roleId of roleIds) {
    await assertMayChangeRoleGrant({ context, granted, permissionIds, req, roleId })
  }
  return data
}

function grantedAfterWrite(
  data: { granted?: unknown } | undefined,
  originalDoc: { granted?: unknown } | undefined,
): boolean {
  if (typeof data?.granted === 'boolean') {
    return data.granted
  }
  return originalDoc?.granted !== false
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
  })) as { permission?: unknown; role?: unknown } | null
  const roleId = relationId(grant?.role)
  if (!roleId) {
    return
  }
  const permissionId = relationId(grant?.permission)
  await assertMayChangeRoleGrant({
    context,
    granted: false,
    permissionIds: permissionId ? [permissionId] : [],
    req,
    roleId,
  })
}
