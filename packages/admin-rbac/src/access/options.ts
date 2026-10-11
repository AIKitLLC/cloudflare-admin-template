import type { PayloadRequest } from 'payload'

import type { RbacCollectionOptions } from './types'

export function readRbacCollectionOptions(
  req: PayloadRequest,
  collectionSlug: string,
): RbacCollectionOptions {
  const collections = req.payload.collections as Record<
    string,
    { config: { custom?: { rbac?: RbacCollectionOptions } } } | undefined
  >
  return collections[collectionSlug]?.config.custom?.rbac ?? {}
}

export function collectionEnablesRbac(custom: unknown): boolean {
  if (!custom || typeof custom !== 'object') {
    return false
  }
  const rbac = (custom as { rbac?: RbacCollectionOptions }).rbac
  return rbac?.enabled === true
}

/** The collection keeps its own access. Coverage must not wrap it or emit CRUD cells. */
export function collectionOwnsAccess(custom: unknown): boolean {
  if (!custom || typeof custom !== 'object') {
    return false
  }
  const rbac = (custom as { rbac?: RbacCollectionOptions }).rbac
  return rbac?.ownsAccess === true
}
