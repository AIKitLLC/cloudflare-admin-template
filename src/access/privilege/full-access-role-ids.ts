import type { CollectionSlug, PayloadRequest } from 'payload'

import { ROLES_SLUG } from '../constants'

export async function fullAccessRoleIds(req: PayloadRequest): Promise<Set<string>> {
  const roles = await req.payload.find({
    collection: ROLES_SLUG as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      grantsFullAccess: {
        equals: true,
      },
    },
  })
  return new Set(roles.docs.map((role) => String(role.id)))
}
