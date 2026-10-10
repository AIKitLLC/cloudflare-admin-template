import type { CollectionSlug, Payload } from 'payload'

import { ROLES_SLUG, SUPER_ADMIN_NAME, SUPER_ADMIN_SLUG } from '../../access/constants'
import { isUniqueConstraintError } from './unique-constraint'

export type SuperAdminRole = {
  id: number | string
  slug?: string | null
  grantsFullAccess?: boolean | null
}

export async function ensureSuperAdminRole(payload: Payload): Promise<SuperAdminRole> {
  const existing = await payload.find({
    collection: ROLES_SLUG as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: {
      slug: {
        equals: SUPER_ADMIN_SLUG,
      },
    },
  })
  const current = existing.docs[0] as SuperAdminRole | undefined
  if (current) {
    if (!current.grantsFullAccess) {
      await payload.update({
        collection: ROLES_SLUG as CollectionSlug,
        id: current.id,
        data: {
          grantsFullAccess: true,
          name: SUPER_ADMIN_NAME,
        },
        overrideAccess: true,
      })
      current.grantsFullAccess = true
    }
    return current
  }

  try {
    const created = await payload.create({
      collection: ROLES_SLUG as CollectionSlug,
      data: {
        name: SUPER_ADMIN_NAME,
        slug: SUPER_ADMIN_SLUG,
        description:
          'Full access to every collection, action, and field. Bypasses the permission matrix so the first administrator cannot be locked out.',
        grantsFullAccess: true,
      },
      overrideAccess: true,
    })
    return created as SuperAdminRole
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error
    }
    const raced = await payload.find({
      collection: ROLES_SLUG as CollectionSlug,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        slug: {
          equals: SUPER_ADMIN_SLUG,
        },
      },
    })
    const winner = raced.docs[0] as SuperAdminRole | undefined
    if (!winner) {
      throw error
    }
    return winner
  }
}
