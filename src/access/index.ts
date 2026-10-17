export {
  COLLECTION_ACTIONS,
  PERMISSION_ACTIONS,
  ROLE_PERMISSIONS_SLUG,
  ROLES_SLUG,
  SUPER_ADMIN_SLUG,
  USERS_SLUG,
} from './constants'
export { collectionAccess } from './collection-access'
export { assertCollectionAction, evaluateCollectionAccess } from './evaluate-collection-access'
export {
  beforeGrantGates,
  registerBeforeGrantGate,
  registerRowScopeContributor,
  rowScopeContributors,
} from './extensions'
export { applyFieldAccess } from './fields/apply-field-access'
export { permissionKey } from './permission-key'
export { userGrantsFullAccess } from './resolve/load-user-grants'
export { isAccessGranted } from './result'
export { withRbac } from './with-rbac'
export type {
  AccessConstraint,
  AccessGate,
  CollectionAction,
  PermissionAction,
  RbacCollectionOptions,
  RowScopeBinding,
  RowScopeContributor,
  ScopeDimension,
} from './types'
