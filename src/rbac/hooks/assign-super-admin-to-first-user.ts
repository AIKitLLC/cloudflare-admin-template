import type { CollectionAfterChangeHook, CollectionSlug } from 'payload'

import { ROLES_SLUG, SUPER_ADMIN_SLUG, USERS_SLUG } from '../../access/constants'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '../guards/privilege-context'
import { hasAssignedRoles, shouldAssignSuperAdminOnCreate } from '../seed/promotion-policy'

export const assignSuperAdminToFirstUser: CollectionAfterChangeHook = async ({
  doc,
  operation,
  req,
  context,
}) => {
  if (context.skipRbacBootstrap) {
    return doc
  }
  const assignedRoleCount = hasAssignedRoles(doc.roles) ? 1 : 0
  if (operation !== 'create' || assignedRoleCount > 0) {
    return doc
  }
  const users = await req.payload.count({
    collection: USERS_SLUG,
    overrideAccess: true,
    req,
  })
  if (
    !shouldAssignSuperAdminOnCreate({
      operation,
      assignedRoleCount,
      totalUsers: users.totalDocs,
    })
  ) {
    return doc
  }
  const roles = await req.payload.find({
    collection: ROLES_SLUG as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      slug: {
        equals: SUPER_ADMIN_SLUG,
      },
    },
  })
  const superAdmin = roles.docs[0]
  if (!superAdmin) {
    return doc
  }
  return req.payload.update({
    collection: USERS_SLUG,
    id: doc.id,
    data: { roles: [superAdmin.id] },
    overrideAccess: true,
    req,
    context: {
      ...context,
      skipRbacBootstrap: true,
      [SKIP_RBAC_PRIVILEGE_CHECKS]: true,
    },
  })
}
