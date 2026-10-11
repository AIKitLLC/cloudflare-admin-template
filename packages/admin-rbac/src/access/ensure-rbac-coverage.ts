import type { CollectionConfig, Payload } from 'payload'

import { INTERNAL_COLLECTION_PREFIX } from './constants'
import { collectionEnablesRbac, collectionOwnsAccess } from './options'
import { withRbac } from './with-rbac'

export function ensureRbacCoverage(collections: CollectionConfig[]): CollectionConfig[] {
  return collections.map((collection) => {
    if (collection.slug.startsWith(INTERNAL_COLLECTION_PREFIX)) {
      return collection
    }
    if (collectionOwnsAccess(collection.custom) || collectionEnablesRbac(collection.custom)) {
      return collection
    }
    return withRbac(collection)
  })
}

export function uncoveredCollectionSlugs(
  collections: { slug: string; custom?: unknown }[],
): string[] {
  return collections
    .filter(
      (collection) =>
        !collection.slug.startsWith(INTERNAL_COLLECTION_PREFIX) &&
        !collectionOwnsAccess(collection.custom) &&
        !collectionEnablesRbac(collection.custom),
    )
    .map((collection) => collection.slug)
}

export function assertRbacCoverage(payload: Payload): void {
  const missing = uncoveredCollectionSlugs(payload.config.collections)
  if (missing.length > 0) {
    throw new Error(
      `RBAC is required for every non-internal collection. Missing withRbac coverage: ${missing.join(', ')}.`,
    )
  }
}
