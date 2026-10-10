import type { Access, CollectionConfig } from 'payload'

import { evaluateCollectionAccess } from './evaluate-collection-access'
import { isPermissionPayloadCall } from './permission-payload-call'
import type { CollectionAction } from './types'

function operation(collectionSlug: string, action: CollectionAction): Access {
  return (args) =>
    evaluateCollectionAccess({
      req: args.req,
      collectionSlug,
      action,
      permissionProbe: isPermissionPayloadCall(args),
    })
}

export function collectionAccess(collectionSlug: string): CollectionConfig['access'] {
  return {
    create: operation(collectionSlug, 'create'),
    read: operation(collectionSlug, 'read'),
    update: operation(collectionSlug, 'update'),
    delete: operation(collectionSlug, 'delete'),
  }
}
