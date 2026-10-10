import type { PermissionAction } from '../../access/types'
import { permissionKey } from '../../access/permission-key'
import {
  fieldDisplayLabel,
  walkPermissionedFields,
  type WalkableField,
} from '../../access/fields/permissioned-field'
import { collectionEnablesRbac } from '../../access/options'
import { COLLECTION_ACTIONS } from '../../access/constants'

export type PermissionDefinition = {
  key: string
  label: string
  groupLabel: string
  collectionSlug: string
  action: PermissionAction
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

export function collectPermissionDefinitions(
  collections: CatalogCollection[],
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
  return definitions
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
