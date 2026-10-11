import type { Access, PayloadRequest, Where } from 'payload'

import { AUDIT_LOG_READER_EMAILS_ENV } from '../constants'

/**
 * What Payload access functions return. `false` denies. `true` allows every
 * row. A `Where` is a row scope. After PR #11, return the value of
 * `evaluateCollectionAccess` for `audit-logs:read` unchanged, including a
 * `Where` from a row-scope contributor.
 */
export type AuditLogAccessResult = boolean | Where

/**
 * Hard gate for reading Audit Logs. Being signed in is not enough.
 *
 * Allows only:
 * - the single earliest user (lowest `users.id`), or
 * - an email listed exactly in `AUDIT_LOG_READER_EMAILS` (comma-separated, empty by default).
 *
 * Everyone else is denied. If the earliest-user lookup throws, returns no row,
 * or returns more than one row, the check fails closed. There is no
 * `access.admin` entry: that hook is only consulted for auth collections.
 */
export async function canReadAuditLogs({
  req,
}: {
  req: PayloadRequest
}): Promise<AuditLogAccessResult> {
  const user = req.user
  if (!user || user.id == null || user.id === '') return false
  if (emailAllowlisted(user.email)) return true
  try {
    return await isEarliestUser(req, user.id)
  } catch (error) {
    req.payload.logger.error({
      err: error,
      msg: 'Audit log read check failed closed.',
    })
    return false
  }
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

function emailAllowlisted(email: unknown): boolean {
  if (typeof email !== 'string' || email.length === 0) return false
  return readerEmails().has(email.trim().toLowerCase())
}

function readerEmails(): Set<string> {
  const raw = process.env[AUDIT_LOG_READER_EMAILS_ENV] ?? ''
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )
}

async function isEarliestUser(req: PayloadRequest, userId: number | string): Promise<boolean> {
  const earliest = await req.payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    sort: 'id',
  })
  const docs = earliest?.docs
  if (!Array.isArray(docs) || docs.length !== 1) return false
  const earliestId = docs[0]?.id
  if (earliestId == null || earliestId === '') return false
  return String(earliestId) === String(userId)
}
