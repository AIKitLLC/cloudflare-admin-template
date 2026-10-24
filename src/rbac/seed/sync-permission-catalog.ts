import type { CollectionSlug, Payload } from 'payload'

import { PERMISSIONS_SLUG } from '../../access'
import {
  collectPermissionDefinitions,
  type PermissionDefinition,
} from '../catalog/permission-definition'
import { isUniqueConstraintError } from './unique-constraint'

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
  const desired = collectPermissionDefinitions(payload.config.collections, payload.config.globals)
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
      const inserted = await createPermission(payload, definition)
      if (inserted) {
        created += 1
        continue
      }
      const raced = await findPermissionByKey(payload, definition.key)
      if (!raced) {
        created += 1
        continue
      }
      byKey.set(definition.key, raced)
      if (needsCatalogUpdate(raced, definition)) {
        await updatePermission(payload, raced.id, definition)
        updated += 1
      }
      continue
    }
    if (needsCatalogUpdate(current, definition)) {
      await updatePermission(payload, current.id, definition)
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

async function createPermission(
  payload: Payload,
  definition: PermissionDefinition,
): Promise<boolean> {
  try {
    await payload.create({
      collection: PERMISSIONS_SLUG as CollectionSlug,
      data: permissionData(definition),
      overrideAccess: true,
    })
    return true
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error
    }
    return false
  }
}

function permissionData(definition: PermissionDefinition) {
  return {
    key: definition.key,
    label: definition.label,
    collectionSlug: definition.collectionSlug,
    action: definition.action,
    fieldPath: definition.fieldPath,
    active: true,
    description: permissionDescription(definition),
  }
}

async function updatePermission(
  payload: Payload,
  id: number | string,
  definition: PermissionDefinition,
): Promise<void> {
  await payload.update({
    collection: PERMISSIONS_SLUG as CollectionSlug,
    id,
    data: {
      label: definition.label,
      collectionSlug: definition.collectionSlug,
      action: definition.action,
      fieldPath: definition.fieldPath ?? null,
      active: true,
    },
    overrideAccess: true,
  })
}

async function findPermissionByKey(
  payload: Payload,
  key: string,
): Promise<PermissionDoc | undefined> {
  const found = await payload.find({
    collection: PERMISSIONS_SLUG as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { key: { equals: key } },
  })
  return found.docs[0] as PermissionDoc | undefined
}

function permissionDescription(definition: PermissionDefinition): string {
  if (definition.action === 'trigger') {
    return `Manually enqueue a registered ${definition.collectionSlug} job.`
  }
  if (definition.action === 'retry') {
    return `Retry a failed ${definition.collectionSlug} job.`
  }
  if (definition.fieldPath) {
    return `Field ${definition.action} on ${definition.collectionSlug}.${definition.fieldPath}`
  }
  if (definition.collectionSlug.startsWith('global:')) {
    return `Global ${definition.action} on ${definition.collectionSlug.slice('global:'.length)}`
  }
  return `Collection ${definition.action} on ${definition.collectionSlug}`
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
