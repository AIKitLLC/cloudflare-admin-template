import type { CollectionSlug, Payload } from 'payload'

import { ROLES_SLUG, SUPER_ADMIN_SLUG } from '../../access'
import { collectPermissionDefinitions } from '../catalog/permission-definition'
import { catalogFingerprint } from './catalog-fingerprint'
import { ensureSuperAdminRole, type SuperAdminRole } from './ensure-super-admin-role'
import { grantSuperAdminPermissions } from './grant-super-admin-permissions'
import { promoteEarliestUnassignedUser, type PromotedUser } from './promote-earliest-user'
import {
  markUpgradePromotionDone,
  readCatalogFingerprint,
  readUpgradePromotionDone,
  writeCatalogFingerprint,
} from './rbac-state'
import { syncPermissionCatalog } from './sync-permission-catalog'

export async function seedRbac(payload: Payload): Promise<void> {
  const definitions = collectPermissionDefinitions(
    payload.config.collections,
    payload.config.globals,
  )
  const fingerprint = catalogFingerprint(definitions)
  const [savedFingerprint, promotionDone, superAdmin] = await Promise.all([
    readCatalogFingerprint(payload),
    readUpgradePromotionDone(payload),
    findSuperAdmin(payload),
  ])
  if (savedFingerprint === fingerprint && promotionDone && superAdmin?.grantsFullAccess) {
    payload.logger.info({ msg: 'RBAC seed skipped' })
    return
  }

  const catalog = savedFingerprint === fingerprint ? null : await syncPermissionCatalog(payload)
  const role = superAdmin?.grantsFullAccess ? superAdmin : await ensureSuperAdminRole(payload)
  const grants =
    savedFingerprint === fingerprint ? 0 : await grantSuperAdminPermissions(payload, role.id)
  let promoted: PromotedUser | null = null
  if (!promotionDone) {
    promoted = await promoteEarliestUnassignedUser(payload, role.id)
    await markUpgradePromotionDone(payload)
  }
  await writeCatalogFingerprint(payload, fingerprint)
  payload.logger.info({
    msg: 'RBAC seed complete',
    permissionsCreated: catalog?.created ?? 0,
    permissionsUpdated: catalog?.updated ?? 0,
    permissionsDeactivated: catalog?.deactivated ?? 0,
    superAdminGrantsWritten: grants,
    usersPromotedToSuperAdmin: promoted ? 1 : 0,
    ...(promoted ? { promotedUserId: promoted.id, promotedUserEmail: promoted.email } : {}),
  })
}

async function findSuperAdmin(payload: Payload): Promise<SuperAdminRole | undefined> {
  const existing = await payload.find({
    collection: ROLES_SLUG as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: {
      slug: {
        equals: SUPER_ADMIN_SLUG,
      },
    },
  })
  return existing.docs[0] as SuperAdminRole | undefined
}
