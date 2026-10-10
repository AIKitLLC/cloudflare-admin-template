import type { PermissionAction } from '../../access/types'
import { permissionKey } from '../../access/permission-key'
import {
  fieldDisplayLabel,
  walkPermissionedFields,
  type WalkableField,
} from '../../access/fields/permissioned-field'
import { globalAccessSlug } from '../../access/global-slug'
import { collectionEnablesRbac } from '../../access/options'
import { COLLECTION_ACTIONS } from '../../access/constants'
import { extraCatalogDefinitions, suppressedPermissionKeys } from './catalog-contributors'

export type CatalogAction = PermissionAction | 'trigger' | 'retry'

export type PermissionDefinition = {
  key: string
  label: string
  groupLabel: string
  collectionSlug: string
  action: CatalogAction
  fieldPath?: string
}

const ACTION_LABELS: Record<PermissionAction, string> = {
  create: 'Create',
  read: 'Read',
  update: 'Update',
  delete: 'Delete',
  export: 'Export',
  readField: 'Field read',
  writeField: 'Field write',
}

type CatalogCollection = {
  slug: string
  labels?: { singular?: unknown }
  custom?: unknown
  fields?: unknown[]
}

type CatalogGlobal = {
  slug: string
  label?: unknown
}

export function collectPermissionDefinitions(
  collections: CatalogCollection[],
  globals: CatalogGlobal[] = [],
): PermissionDefinition[] {
  const definitions: PermissionDefinition[] = []
  for (const collection of collections) {
    if (!collectionEnablesRbac(collection.custom)) {
      continue
    }
    const groupLabel = collectionGroupLabel(collection)
    for (const action of COLLECTION_ACTIONS) {
      definitions.push({
        key: permissionKey(collection.slug, action),
        label: `${groupLabel} · ${ACTION_LABELS[action]}`,
        groupLabel,
        collectionSlug: collection.slug,
        action,
      })
    }
    walkPermissionedFields((collection.fields ?? []) as WalkableField[], (field, fieldPath) => {
      const fieldLabel = fieldDisplayLabel(field)
      definitions.push(
        fieldDefinition(collection.slug, groupLabel, fieldLabel, fieldPath, 'readField'),
        fieldDefinition(collection.slug, groupLabel, fieldLabel, fieldPath, 'writeField'),
      )
    })
  }
  for (const globalConfig of globals) {
    const groupLabel = globalGroupLabel(globalConfig)
    const slug = globalAccessSlug(globalConfig.slug)
    for (const action of ['read', 'update'] as const) {
      definitions.push({
        key: permissionKey(slug, action),
        label: `${groupLabel} · ${ACTION_LABELS[action]}`,
        groupLabel,
        collectionSlug: slug,
        action,
      })
    }
  }
  const suppressed = suppressedPermissionKeys()
  return [
    ...definitions.filter((definition) => !suppressed.has(definition.key)),
    ...extraCatalogDefinitions(),
  ]
}

function globalGroupLabel(globalConfig: CatalogGlobal): string {
  if (typeof globalConfig.label === 'string' && globalConfig.label.trim()) {
    return globalConfig.label
  }
  return globalConfig.slug
}

function fieldDefinition(
  collectionSlug: string,
  groupLabel: string,
  fieldLabel: string,
  fieldPath: string,
  action: 'readField' | 'writeField',
): PermissionDefinition {
  return {
    key: permissionKey(collectionSlug, action, fieldPath),
    label: `${groupLabel} · ${fieldLabel} · ${ACTION_LABELS[action]}`,
    groupLabel,
    collectionSlug,
    action,
    fieldPath,
  }
}

function collectionGroupLabel(collection: CatalogCollection): string {
  const singular = collection.labels?.singular
  if (typeof singular === 'string' && singular.trim()) {
    return singular
  }
  return collection.slug
}
