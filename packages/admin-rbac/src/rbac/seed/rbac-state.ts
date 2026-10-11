import type { CollectionSlug, Payload } from 'payload'

import { isUniqueConstraintError } from './unique-constraint'

const KV_SLUG = 'payload-kv' as CollectionSlug
const CATALOG_FINGERPRINT = 'rbac:catalog_fingerprint'
const UPGRADE_PROMOTION = 'rbac:upgrade_promotion'
const PROMOTION_DONE = 'done'

type KvDoc = {
  id: number | string
  key?: string | null
  data?: unknown
}

export async function readCatalogFingerprint(payload: Payload): Promise<string | null> {
  return readState(payload, CATALOG_FINGERPRINT)
}

export async function writeCatalogFingerprint(
  payload: Payload,
  fingerprint: string,
): Promise<void> {
  await writeState(payload, CATALOG_FINGERPRINT, fingerprint)
}

export async function readUpgradePromotionDone(payload: Payload): Promise<boolean> {
  return (await readState(payload, UPGRADE_PROMOTION)) === PROMOTION_DONE
}

export async function markUpgradePromotionDone(payload: Payload): Promise<void> {
  await writeState(payload, UPGRADE_PROMOTION, PROMOTION_DONE)
}

async function readState(payload: Payload, key: string): Promise<string | null> {
  const found = await payload.find({
    collection: KV_SLUG,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { key: { equals: key } },
  })
  return stateValue((found.docs[0] as KvDoc | undefined)?.data)
}

async function writeState(payload: Payload, key: string, value: string): Promise<void> {
  const found = await payload.find({
    collection: KV_SLUG,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { key: { equals: key } },
  })
  const current = found.docs[0] as KvDoc | undefined
  if (current) {
    if (stateValue(current.data) === value) {
      return
    }
    await payload.update({
      collection: KV_SLUG,
      id: current.id,
      data: { data: { value } },
      overrideAccess: true,
    })
    return
  }
  try {
    await payload.create({
      collection: KV_SLUG,
      data: { key, data: { value } },
      overrideAccess: true,
    })
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error
    }
  }
}

function stateValue(data: unknown): string | null {
  if (typeof data === 'string') {
    return data
  }
  if (data && typeof data === 'object' && 'value' in data) {
    const value = (data as { value?: unknown }).value
    return typeof value === 'string' ? value : null
  }
  return null
}
