import type { CollectionSlug, Payload } from 'payload'

import { PERMISSIONS_SLUG, ROLE_PERMISSIONS_SLUG } from '../../access'
import { relationId } from '../../access'
import { setRoleGrant } from '../matrix/set-role-grant'

export async function grantSuperAdminPermissions(
  payload: Payload,
  roleId: number | string,
): Promise<number> {
  const permissions = await payload.find({
    collection: PERMISSIONS_SLUG as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    where: {
      active: {
        equals: true,
      },
    },
  })
  const existing = await payload.find({
    collection: ROLE_PERMISSIONS_SLUG as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    where: {
      role: {
        equals: roleId,
      },
    },
  })
  const grantedByPermission = new Map(
    existing.docs.map((doc) => {
      const record = doc as { permission?: unknown; granted?: boolean | null }
      return [relationId(record.permission), record.granted !== false]
    }),
  )

  let changes = 0
  for (const permission of permissions.docs) {
    const permissionId = (permission as { id: number | string }).id
    if (grantedByPermission.get(String(permissionId)) === true) {
      continue
    }
    await setRoleGrant(payload, {
      roleId,
      permissionId,
      granted: true,
    })
    changes += 1
  }
  return changes
}
