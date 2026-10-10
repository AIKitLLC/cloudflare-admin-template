import type { CollectionSlug, Payload } from 'payload'

import { USERS_SLUG } from '../../access/constants'
import { shouldPromoteUnassignedUsers } from './promotion-policy'

export async function promoteUnassignedUsers(
  payload: Payload,
  superAdminRoleId: number | string,
): Promise<number> {
  const users = await payload.find({
    collection: USERS_SLUG,
    depth: 0,
    overrideAccess: true,
    pagination: false,
  })
  const docs = users.docs as { id: number | string; roles?: unknown }[]
  if (!shouldPromoteUnassignedUsers(docs)) {
    return 0
  }
  for (const user of docs) {
    await payload.update({
      collection: USERS_SLUG as CollectionSlug,
      id: user.id,
      data: { roles: [Number(superAdminRoleId)] },
      overrideAccess: true,
    })
  }
  return docs.length
}
