import type { CollectionConfig, GlobalConfig, Payload } from 'payload'

import { collectionAccess } from './collection-access'
import { INTERNAL_COLLECTION_PREFIX } from './constants'
import { createExportEndpoint } from './export/create-export-endpoint'
import { globalOperation } from './global-access'
import { collectionEnablesRbac, collectionOwnsAccess } from './options'

type EndpointLike = {
  method?: string
  path?: string
}

export function applyRbacToUnwrappedCollection(collection: CollectionConfig): void {
  if (collection.slug.startsWith(INTERNAL_COLLECTION_PREFIX)) {
    return
  }
  if (collectionOwnsAccess(collection.custom) || collectionEnablesRbac(collection.custom)) {
    return
  }
  collection.custom = {
    ...(collection.custom ?? {}),
    rbac: {
      enabled: true,
    },
  }
  collection.access = {
    ...(collection.access ?? {}),
    ...collectionAccess(collection.slug),
  }
  if (!hasExportEndpoint(collection.endpoints)) {
    const endpoints = Array.isArray(collection.endpoints) ? collection.endpoints : []
    collection.endpoints = [...endpoints, createExportEndpoint(collection.slug)]
  }
}

export function applyRbacToGlobal(globalConfig: GlobalConfig): void {
  globalConfig.custom = {
    ...(globalConfig.custom ?? {}),
    rbac: {
      enabled: true,
    },
  }
  globalConfig.access = {
    ...(globalConfig.access ?? {}),
    read: globalOperation(globalConfig.slug, 'read'),
    readVersions: globalOperation(globalConfig.slug, 'read'),
    update: globalOperation(globalConfig.slug, 'update'),
  }
}

export function coverLiveConfig(payload: Payload): void {
  for (const collection of payload.config.collections) {
    applyRbacToUnwrappedCollection(collection)
  }
  for (const globalConfig of payload.config.globals) {
    applyRbacToGlobal(globalConfig)
  }
}

function hasExportEndpoint(endpoints: CollectionConfig['endpoints']): boolean {
  if (!Array.isArray(endpoints)) {
    return false
  }
  return endpoints.some((endpoint) => {
    const candidate = endpoint as EndpointLike
    return candidate.path === '/export' && candidate.method === 'get'
  })
}
