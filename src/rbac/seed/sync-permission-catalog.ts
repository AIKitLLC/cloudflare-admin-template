import type { CollectionSlug, Payload } from 'payload'

import { PERMISSIONS_SLUG } from '../../access/constants'
import {
  collectPermissionDefinitions,
  type PermissionDefinition,
} from '../catalog/permission-definition'

type PermissionDoc = {
  id: number | string
  key: string
  label?: string | null
  collectionSlug?: string | null
  action?: string | null
  fieldPath?: string | null
  active?: boolean | null
}

export async function syncPermissionCatalog(
  payload: Payload,
): Promise<{ created: number; updated: number; deactivated: number }> {
  const desired = collectPermissionDefinitions(payload.config.collections)
  const existing = await payload.find({
    collection: PERMISSIONS_SLUG as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
  })
  const byKey = new Map(
    existing.docs.map((doc) => [(doc as PermissionDoc).key, doc as PermissionDoc]),
  )
  const desiredKeys = new Set(desired.map((definition) => definition.key))
  let created = 0
  let updated = 0
  let deactivated = 0

  for (const definition of desired) {
    const current = byKey.get(definition.key)
    if (!current) {
      await payload.create({
        collection: PERMISSIONS_SLUG as CollectionSlug,
        data: {
          key: definition.key,
          label: definition.label,
          collectionSlug: definition.collectionSlug,
          action: definition.action,
          fieldPath: definition.fieldPath,
          active: true,
          description: definition.fieldPath
            ? `Field ${definition.action} on ${definition.collectionSlug}.${definition.fieldPath}`
            : `Collection ${definition.action} on ${definition.collectionSlug}`,
        },
        overrideAccess: true,
      })
      created += 1
      continue
    }
    if (needsCatalogUpdate(current, definition)) {
      await payload.update({
        collection: PERMISSIONS_SLUG as CollectionSlug,
        id: current.id,
        data: {
          label: definition.label,
          collectionSlug: definition.collectionSlug,
          action: definition.action,
          fieldPath: definition.fieldPath ?? null,
          active: true,
        },
        overrideAccess: true,
      })
      updated += 1
    }
  }

  for (const current of byKey.values()) {
    if (!desiredKeys.has(current.key) && current.active !== false) {
      await payload.update({
        collection: PERMISSIONS_SLUG as CollectionSlug,
        id: current.id,
        data: { active: false },
        overrideAccess: true,
      })
      deactivated += 1
    }
  }

  return { created, updated, deactivated }
}

function needsCatalogUpdate(current: PermissionDoc, definition: PermissionDefinition): boolean {
  return (
    current.active === false ||
    current.label !== definition.label ||
    current.collectionSlug !== definition.collectionSlug ||
    current.action !== definition.action ||
    (current.fieldPath ?? undefined) !== definition.fieldPath
  )
}
