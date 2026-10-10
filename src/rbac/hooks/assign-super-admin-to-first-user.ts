import type { CollectionAfterChangeHook } from 'payload'

import { USERS_SLUG } from '../../access/constants'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '../guards/privilege-context'
import { ensureSuperAdminRole } from '../seed/ensure-super-admin-role'
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
  const superAdmin = await ensureSuperAdminRole(req.payload)
  return req.payload.update({
    collection: USERS_SLUG,
    id: doc.id,
    data: { roles: [Number(superAdmin.id)] },
    overrideAccess: true,
    req,
    context: {
      ...context,
      skipRbacBootstrap: true,
      [SKIP_RBAC_PRIVILEGE_CHECKS]: true,
    },
  })
}
