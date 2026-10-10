import type { CollectionConfig } from 'payload'

import { scopeHooksFor } from '../scope/hooks/scope-hooks-for'
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
    hooks: appendScopeHooks(collection.hooks, options),
    endpoints: [
      ...(Array.isArray(collection.endpoints) ? collection.endpoints : []),
      createExportEndpoint(collection.slug),
    ],
  }
}

function appendScopeHooks(
  hooks: CollectionConfig['hooks'],
  options: RbacCollectionOptions,
): CollectionConfig['hooks'] {
  const extra = scopeHooksFor(options.rowScope)
  if (!extra) {
    return hooks
  }
  return {
    ...hooks,
    beforeOperation: [...(hooks?.beforeOperation ?? []), ...(extra.beforeOperation ?? [])],
    beforeChange: [...(hooks?.beforeChange ?? []), ...(extra.beforeChange ?? [])],
    afterChange: [...(hooks?.afterChange ?? []), ...(extra.afterChange ?? [])],
    afterDelete: [...(hooks?.afterDelete ?? []), ...(extra.afterDelete ?? [])],
  }
}
