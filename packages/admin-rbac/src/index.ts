export {
  COLLECTION_ACTIONS,
  PERMISSION_ACTIONS,
  ROLE_PERMISSIONS_SLUG,
  ROLES_SLUG,
  SUPER_ADMIN_SLUG,
  USERS_SLUG,
} from './access/constants'
export { collectionAccess } from './access/collection-access'
export { assertCollectionAction, evaluateCollectionAccess } from './access/evaluate-collection-access'
export { exportCollection } from './access/export/create-export-endpoint'
export {
  beforeGrantGates,
  registerBeforeGrantGate,
  registerRowScopeContributor,
  rowScopeContributors,
} from './access/extensions'
export { applyFieldAccess } from './access/fields/apply-field-access'
export { policyGate } from './access/gates/policy-gate'
export { unauthenticatedGate } from './access/gates/unauthenticated-gate'
export {
  collectionEnablesRbac,
  collectionOwnsAccess,
  readRbacCollectionOptions,
} from './access/options'
export { permissionKey } from './access/permission-key'
export { isPermissionPayloadCall, permissionDocumentId } from './access/permission-payload-call'
export { relationId, relationIds } from './access/relation-id'
export { loadUserGrants, userGrantsFullAccess } from './access/resolve/load-user-grants'
export { isAccessGranted } from './access/result'
export { withRbac } from './access/with-rbac'
export type {
  AccessConstraint,
  AccessEvaluationContext,
  AccessGate,
  CollectionAction,
  PermissionAction,
  RbacCollectionOptions,
  RowScopeBinding,
  RowScopeContributor,
  ScopeDimension,
} from './access/types'

export { registerCatalogActions, registerCatalogContributor } from './rbac/catalog/catalog-contributors'
export type { PermissionDefinition } from './rbac/catalog/permission-definition'
export {
  guardAuthCredentialOperation,
  guardLastFullAccessDeletion,
  guardUserRoleAssignment,
} from './rbac/guards/guard-full-access-assignment'
export { fullAccessRoleIds } from './rbac/guards/full-access-role-ids'
export { skipsPrivilegeChecks } from './rbac/guards/privilege-context'
export { addedRoleIds, roleIdList } from './rbac/guards/role-id-set'
export { grantedKeysByRole } from './rbac/guards/role-permission-keys'
export { assignSuperAdminToFirstUser } from './rbac/hooks/assign-super-admin-to-first-user'
export { registerRoleGrantCheck, registerUserTargetCheck } from './rbac/extensions/external-checks'

export { adminRbac } from './plugin'
export { seedRbac } from './rbac/seed/seed-rbac'
