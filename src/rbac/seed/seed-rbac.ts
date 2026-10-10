import type { Payload } from 'payload'

import { ensureSuperAdminRole } from './ensure-super-admin-role'
import { grantSuperAdminPermissions } from './grant-super-admin-permissions'
import { promoteUnassignedUsers } from './promote-unassigned-users'
import { syncPermissionCatalog } from './sync-permission-catalog'

export async function seedRbac(payload: Payload): Promise<void> {
  const catalog = await syncPermissionCatalog(payload)
  const superAdmin = await ensureSuperAdminRole(payload)
  const grants = await grantSuperAdminPermissions(payload, superAdmin.id)
  const promoted = await promoteUnassignedUsers(payload, superAdmin.id)
  payload.logger.info({
    msg: 'RBAC seed complete',
    permissionsCreated: catalog.created,
    permissionsUpdated: catalog.updated,
    permissionsDeactivated: catalog.deactivated,
    superAdminGrantsWritten: grants,
    usersPromotedToSuperAdmin: promoted,
  })
}
