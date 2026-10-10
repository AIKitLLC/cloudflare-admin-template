import type { PayloadRequest } from 'payload'

import { fieldPermissionKey } from '../permission-key'
import { readRbacCollectionOptions } from '../options'
import { loadUserGrants } from '../resolve/load-user-grants'
import type { FieldAccessMode } from '../types'

function documentId(args: {
  id?: unknown
  doc?: { id?: unknown } | null
}): number | string | undefined {
  if (typeof args.id === 'number' || typeof args.id === 'string') {
    return args.id
  }
  const docId = args.doc?.id
  if (typeof docId === 'number' || typeof docId === 'string') {
    return docId
  }
  return undefined
}

function isOwnDocument(
  req: PayloadRequest,
  collectionSlug: string,
  docId: number | string | undefined,
): boolean {
  if (!req.user || docId === undefined) {
    return false
  }
  if (req.user.collection && req.user.collection !== collectionSlug) {
    return false
  }
  return String(req.user.id) === String(docId)
}

export async function evaluateFieldAccess(args: {
  req: PayloadRequest
  collectionSlug: string
  fieldPath: string
  mode: FieldAccessMode
  id?: unknown
  doc?: { id?: unknown } | null
}): Promise<boolean> {
  const options = readRbacCollectionOptions(args.req, args.collectionSlug)
  if (!args.req.user) {
    return Boolean(options.anonymousRead && args.mode === 'read')
  }

  const grants = await loadUserGrants(args.req)
  if (grants?.fullAccess) {
    return true
  }

  const topLevelField = args.fieldPath.split('.')[0] ?? args.fieldPath
  const ownDocument = isOwnDocument(args.req, args.collectionSlug, documentId(args))
  if (options.selfService && ownDocument) {
    if (args.mode === 'read') {
      return true
    }
    const allowlist = new Set(options.selfServiceFields ?? [])
    if (allowlist.has(topLevelField)) {
      return true
    }
  }

  const action = args.mode === 'read' ? 'readField' : 'writeField'
  const key = fieldPermissionKey(args.collectionSlug, action, args.fieldPath)
  return grants?.permissionKeys.has(key) ?? false
}
