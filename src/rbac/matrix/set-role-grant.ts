import type { CollectionSlug, Payload, PayloadRequest } from 'payload'

import { ROLE_PERMISSIONS_SLUG } from '../../access/constants'
import { isUniqueConstraintError } from '../seed/unique-constraint'

export async function setRoleGrant(
  payload: Payload,
  args: { roleId: number | string; permissionId: number | string; granted: boolean },
  req?: PayloadRequest,
): Promise<void> {
  const existing = await payload.find({
    collection: ROLE_PERMISSIONS_SLUG as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
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
      req,
    })
    return
  }
  try {
    await payload.create({
      collection: ROLE_PERMISSIONS_SLUG as CollectionSlug,
      data: {
        role: Number(args.roleId),
        permission: Number(args.permissionId),
        granted: args.granted,
      },
      overrideAccess: true,
      req,
    })
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error
    }
    const raced = await payload.find({
      collection: ROLE_PERMISSIONS_SLUG as CollectionSlug,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: {
        and: [{ role: { equals: args.roleId } }, { permission: { equals: args.permissionId } }],
      },
    })
    const winner = raced.docs[0] as { id: number | string } | undefined
    if (!winner) {
      throw error
    }
    await payload.update({
      collection: ROLE_PERMISSIONS_SLUG as CollectionSlug,
      id: winner.id,
      data: { granted: args.granted },
      overrideAccess: true,
      req,
    })
  }
}
