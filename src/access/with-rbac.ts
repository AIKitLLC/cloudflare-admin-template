import type { CollectionConfig } from 'payload'

import { collectionAccess } from './collection-access'
import { createExportEndpoint } from './export/create-export-endpoint'
import type { RbacCollectionOptions } from './types'

export function withRbac(
  collection: CollectionConfig,
  options: RbacCollectionOptions = {},
): CollectionConfig {
  return {
    ...collection,
    custom: {
      ...(collection.custom ?? {}),
      rbac: {
        enabled: true,
        ...options,
      },
    },
    access: {
      ...collectionAccess(collection.slug),
      ...(collection.access ?? {}),
    },
    endpoints: [
      ...(Array.isArray(collection.endpoints) ? collection.endpoints : []),
      createExportEndpoint(collection.slug),
    ],
  }
}
