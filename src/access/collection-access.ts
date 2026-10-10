import type { CollectionConfig } from 'payload'

import { evaluateCollectionAccess } from './evaluate-collection-access'
import type { CollectionAction } from './types'

function operation(collectionSlug: string, action: CollectionAction) {
  return ({ req }: { req: Parameters<typeof evaluateCollectionAccess>[0]['req'] }) =>
    evaluateCollectionAccess({ req, collectionSlug, action })
}

export function collectionAccess(collectionSlug: string): CollectionConfig['access'] {
  return {
    create: operation(collectionSlug, 'create'),
    read: operation(collectionSlug, 'read'),
    update: operation(collectionSlug, 'update'),
    delete: operation(collectionSlug, 'delete'),
  }
}
