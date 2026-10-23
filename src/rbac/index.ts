export { registerCatalogContributor } from './catalog/catalog-contributors'
export type { PermissionDefinition } from './catalog/permission-definition'
export { Permissions } from './collections/Permissions'
export { RolePermissions } from './collections/RolePermissions'
export { Roles } from './collections/Roles'
export { grantEndpoint, matrixEndpoint } from './endpoints/matrix-handlers'
export {
  guardAuthCredentialOperation,
  guardLastFullAccessDeletion,
  guardUserRoleAssignment,
} from './guards/guard-full-access-assignment'
export { assignSuperAdminToFirstUser } from './hooks/assign-super-admin-to-first-user'
export { ensureSuperAdminRole } from './seed/ensure-super-admin-role'
export { seedRbac } from './seed/seed-rbac'
