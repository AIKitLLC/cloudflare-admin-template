import type { PayloadRequest } from 'payload'
import { APIError } from 'payload'

import { loadUserGrants } from '../../access'
import { fullAccessRoleIds, grantedKeysByRole } from '../../access'
import { SCOPE_TARGET_KEYS_ERROR } from '../errors'

/** Full-access targets and any key the actor does not hold block a scope extension. */
export async function assertTargetKeysWithinActor(
  req: PayloadRequest,
  roleIds: string[],
): Promise<void> {
  const privilegedRoles = await fullAccessRoleIds(req)
  if (roleIds.some((roleId) => privilegedRoles.has(roleId))) {
    throw new APIError(SCOPE_TARGET_KEYS_ERROR, 403)
  }
  const [grants, keysByRole] = await Promise.all([
    loadUserGrants(req),
    grantedKeysByRole(req, roleIds),
  ])
  for (const keys of keysByRole.values()) {
    for (const key of keys) {
      if (!grants?.permissionKeys.has(key)) {
        throw new APIError(SCOPE_TARGET_KEYS_ERROR, 403)
      }
    }
  }
}
