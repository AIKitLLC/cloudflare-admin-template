import type { CollectionSlug, Payload } from 'payload'

import { USERS_SLUG } from '../../access/constants'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '../guards/privilege-context'
import { earliestUser, shouldPromoteUnassignedUsers } from './promotion-policy'

export type PromotedUser = {
  id: number | string
  email: string | null
}

type UserDoc = {
  id: number | string
  email?: string | null
  roles?: unknown
  createdAt?: string | null
}

export async function promoteEarliestUnassignedUser(
  payload: Payload,
  superAdminRoleId: number | string,
): Promise<PromotedUser | null> {
  const users = await payload.find({
    collection: USERS_SLUG,
    depth: 0,
    overrideAccess: true,
    pagination: false,
  })
  const docs = users.docs as UserDoc[]
  if (!shouldPromoteUnassignedUsers(docs)) {
    return null
  }
  const user = earliestUser(docs)
  if (!user) {
    return null
  }
  await payload.update({
    collection: USERS_SLUG as CollectionSlug,
    id: user.id,
    data: { roles: [Number(superAdminRoleId)] },
    overrideAccess: true,
    context: {
      skipRbacBootstrap: true,
      [SKIP_RBAC_PRIVILEGE_CHECKS]: true,
    },
  })
  const promoted = { id: user.id, email: user.email ?? null }
  payload.logger.info({
    msg: 'Promoted the earliest existing user to super-admin',
    userId: promoted.id,
    email: promoted.email,
  })
  return promoted
}
