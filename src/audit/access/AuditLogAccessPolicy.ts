import type { Access, PayloadRequest } from 'payload'

/**
 * Access policy for Audit Logs. This file is the only place that decides who
 * can see or mutate the trail.
 *
 * Issue #1 (RBAC) adds Roles, Permissions, and RolePermissions and checks
 * action-based permissions per collection. When that lands, replace
 * `authenticatedOperator` with the permission matrix, for example:
 *
 *   read: ({ req }) => hasCollectionPermission(req.user, 'audit-logs', 'read')
 *   admin: ({ req }) => hasCollectionPermission(req.user, 'audit-logs', 'read')
 *
 * Keep `create`, `update`, and `delete` returning false. Append-only is not a
 * role grant: a role with update/delete on other collections must not gain
 * them here. Field-level RBAC should leave every audit field read-only.
 * `rejectAuditLogUpdate` / `rejectAuditLogDelete` stay in place so
 * `overrideAccess` cannot bypass the invariant.
 *
 * Until #1 merges, every authenticated admin user can read. The template has
 * one auth collection and no roles, so "authenticated" is the whole operator set.
 */
export function authenticatedOperator({ req }: { req: PayloadRequest }): boolean {
  return Boolean(req.user)
}

export const auditLogAccess: {
  admin: (args: { req: PayloadRequest }) => boolean
  create: Access
  read: Access
  update: Access
  delete: Access
} = {
  admin: authenticatedOperator,
  create: () => false,
  read: authenticatedOperator,
  update: () => false,
  delete: () => false,
}
