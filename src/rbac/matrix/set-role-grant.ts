import type { CollectionSlug, Payload } from 'payload'

import { ROLE_PERMISSIONS_SLUG } from '../../access/constants'

export async function setRoleGrant(
  payload: Payload,
  args: { roleId: number | string; permissionId: number | string; granted: boolean },
): Promise<void> {
  const existing = await payload.find({
    collection: ROLE_PERMISSIONS_SLUG as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: {
      and: [{ role: { equals: args.roleId } }, { permission: { equals: args.permissionId } }],
    },
  })
  const current = existing.docs[0] as { id: number | string } | undefined
  if (current) {
    await payload.update({
      collection: ROLE_PERMISSIONS_SLUG as CollectionSlug,
      id: current.id,
      data: { granted: args.granted },
      overrideAccess: true,
    })
    return
  }
  await payload.create({
    collection: ROLE_PERMISSIONS_SLUG as CollectionSlug,
    data: {
      role: Number(args.roleId),
      permission: Number(args.permissionId),
      granted: args.granted,
    },
    overrideAccess: true,
  })
}
