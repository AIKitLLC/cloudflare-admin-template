import type { Access, PayloadRequest } from 'payload'

/**
 * The only read check for Audit Logs. `read` and `admin` both call this.
 * Create, update, and delete stay denied in `auditLogAccess` and are not
 * decided here.
 *
 * Until issue #1 lands, any authenticated operator can read. There are no roles.
 *
 * After PR #11, replace this body with the matrix read grant. Do not wrap
 * `AuditLogs` in `withRbac`: that wrapper installs create, update, and delete
 * from the matrix, and append-only is not a grant. `custom.rbac.enabled` is
 * already set so the catalog sync emits `audit-logs:read` (and the other
 * action keys) without taking over access.
 *
 *   import { evaluateCollectionAccess, isAccessGranted } from '@/access'
 *
 *   export async function canReadAuditLogs({ req }: { req: PayloadRequest }) {
 *     const decision = await evaluateCollectionAccess({
 *       req,
 *       collectionSlug: 'audit-logs',
 *       action: 'read',
 *     })
 *     return isAccessGranted(decision)
 *   }
 *
 * `evaluateCollectionAccess` allows a `grantsFullAccess` role and a granted
 * `audit-logs:read` key. It denies everyone else. Leave create, update, and
 * delete as `() => false` so `audit-logs:update` and `audit-logs:delete` in
 * the matrix cannot change history. Keep the reject hooks so `overrideAccess`
 * cannot either.
 */
export function canReadAuditLogs({ req }: { req: PayloadRequest }): boolean {
  return Boolean(req.user)
}

export const auditLogAccess: {
  admin: (args: { req: PayloadRequest }) => boolean
  create: Access
  read: Access
  update: Access
  delete: Access
} = {
  admin: canReadAuditLogs,
  create: () => false,
  read: canReadAuditLogs,
  update: () => false,
  delete: () => false,
}
