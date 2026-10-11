import {
  Forbidden,
  type CollectionSlug,
  type Endpoint,
  type PayloadRequest,
  type Where,
} from 'payload'

import { evaluateCollectionAccess } from '../evaluate-collection-access'
import { isAccessGranted, isWhereConstraint } from '../result'
import { toCsv } from './to-csv'

const PAGE_SIZE = 200
const MAX_ROWS = 2000
const AUTH_EXPORT_FIELDS = new Set([
  'hash',
  'salt',
  'resetPasswordToken',
  'resetPasswordExpiration',
  'loginAttempts',
  'lockUntil',
  'sessions',
])

export function omitAuthSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const visible: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (!AUTH_EXPORT_FIELDS.has(key)) {
      visible[key] = value
    }
  }
  return visible
}

export function createExportEndpoint(collectionSlug: string): Endpoint {
  return {
    path: '/export',
    method: 'get',
    handler: (req) => exportCollection(req, collectionSlug),
  }
}

export async function exportCollection(
  req: PayloadRequest,
  collectionSlug: string,
): Promise<Response> {
  if (!req.user) {
    return Response.json({ error: 'Authentication is required.' }, { status: 401 })
  }

  const decision = await evaluateCollectionAccess({
    req,
    collectionSlug,
    action: 'export',
  })
  if (!isAccessGranted(decision)) {
    return Response.json(
      { error: 'You do not have export permission for this collection.' },
      { status: 403 },
    )
  }

  const scope = isWhereConstraint(decision) ? decision : undefined
  let rows: { docs: Record<string, unknown>[]; truncated: boolean }
  try {
    rows = await readExportRows(req, collectionSlug, scope)
  } catch (error) {
    if (error instanceof Forbidden) {
      return Response.json(
        { error: 'Export also requires read access to this collection.' },
        { status: 403 },
      )
    }
    throw error
  }
  const csv = toCsv(rows.docs.map(omitAuthSecrets))
  const headers = new Headers({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${collectionSlug}.csv"`,
  })
  if (rows.truncated) {
    headers.set('X-Export-Truncated', 'true')
  }
  return new Response(csv, { status: 200, headers })
}

async function readExportRows(
  req: PayloadRequest,
  collectionSlug: string,
  scope: Where | undefined,
): Promise<{ docs: Record<string, unknown>[]; truncated: boolean }> {
  const docs: Record<string, unknown>[] = []
  let page = 1
  let truncated = false

  while (docs.length < MAX_ROWS) {
    const result = await req.payload.find({
      collection: collectionSlug as CollectionSlug,
      depth: 0,
      limit: PAGE_SIZE,
      overrideAccess: false,
      page,
      req,
      user: req.user,
      where: scope,
    })
    docs.push(...(result.docs as unknown as Record<string, unknown>[]))
    if (!result.hasNextPage || result.docs.length === 0) {
      break
    }
    if (docs.length >= MAX_ROWS) {
      truncated = true
      break
    }
    page += 1
  }

  if (docs.length > MAX_ROWS) {
    return { docs: docs.slice(0, MAX_ROWS), truncated: true }
  }
  return { docs, truncated }
}
