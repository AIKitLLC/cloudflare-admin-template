import { randomBytes } from 'node:crypto'

import type { APIRequestContext } from '@playwright/test'

import { api, type ApiResult } from './api'
import { adminToken } from './sign-in'

/** A valid 1x1 PNG, so a test needs no fixture file. */
export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082',
  'hex',
)

/**
 * A file name no other test or retry uses. It ends in a letter on purpose: Payload renames a
 * duplicate by incrementing a trailing number (`a-1.png` becomes `a-2.png`) and by adding `-1`
 * otherwise, so a random all-digit tail would be incremented instead.
 */
export function uniqueFilename(extension = 'png'): string {
  return `e2e-${randomBytes(4).toString('hex')}-pic.${extension}`
}

/** `POST /api/media` as multipart. `alt` is left out of the payload when undefined. */
export async function uploadMedia(
  request: APIRequestContext,
  {
    token,
    filename = uniqueFilename(),
    alt,
    mimeType = 'image/png',
    buffer = PNG,
    ip,
  }: {
    token: string
    filename?: string
    alt?: string
    mimeType?: string
    buffer?: Buffer
    ip?: string
  },
): Promise<ApiResult> {
  return api(request, {
    method: 'POST',
    path: '/api/media',
    token,
    ip,
    multipart: {
      _payload: JSON.stringify(alt === undefined ? {} : { alt }),
      file: { name: filename, mimeType, buffer },
    },
  })
}

export type AuditEntry = {
  id: number
  action: 'CREATE' | 'UPDATE' | 'DELETE'
  collectionSlug: string
  documentId: string
  summary: string
  actorEmail: string | null
  ipAddress: string | null
  changes: { path: string; oldValue: unknown; newValue: unknown }[]
}

/**
 * The audit entries of one document since `since` (an ISO time taken before the test's first
 * change), oldest first. The table is shared and SQLite reuses the id of a deleted row, so an id
 * alone also matches an earlier document's history.
 */
export async function auditEntries(
  request: APIRequestContext,
  {
    collection,
    id,
    since,
    token = adminToken(),
  }: { collection: string; id: number; since: string; token?: string },
): Promise<AuditEntry[]> {
  const { status, body } = await api(request, {
    method: 'GET',
    path:
      `/api/audit-logs?where[collectionSlug][equals]=${collection}` +
      `&where[documentId][equals]=${id}&where[occurredAt][greater_than_equal]=${encodeURIComponent(since)}` +
      '&sort=occurredAt&limit=50&depth=0',
    token,
  })
  if (status !== 200) throw new Error(`Reading the audit trail answered ${status}`)
  return body.docs as AuditEntry[]
}
