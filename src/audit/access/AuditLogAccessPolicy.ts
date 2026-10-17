import type { Access, PayloadRequest, Where } from 'payload'

import { evaluateCollectionAccess } from '../../access/evaluate-collection-access'
import { AUDIT_LOGS_SLUG } from '../constants'

/**
 * What Payload access functions return. `false` denies. `true` allows every
 * row. A `Where` is a row scope. The value of `evaluateCollectionAccess` for
 * `audit-logs:read` is returned unchanged, including a `Where` from a
 * row-scope contributor. Do not pass it through `isAccessGranted`.
 */
export type AuditLogAccessResult = boolean | Where

/**
 * Read gate for Audit Logs. Returns the `audit-logs:read` decision.
 * Full access still passes. There is no `access.admin` entry: that hook is
 * only consulted for auth collections.
 */
export async function canReadAuditLogs({
  req,
}: {
  req: PayloadRequest
}): Promise<AuditLogAccessResult> {
  return evaluateCollectionAccess({
    req,
    collectionSlug: AUDIT_LOGS_SLUG,
    action: 'read',
  })
}

export const auditLogAccess: {
  create: Access
  read: Access
  update: Access
  delete: Access
} = {
  create: () => false,
  read: canReadAuditLogs,
  update: () => false,
  delete: () => false,
}
