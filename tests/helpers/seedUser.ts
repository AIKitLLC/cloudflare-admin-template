import { getPayload, type CollectionSlug } from 'payload'
import config from '../../src/payload.config.js'

import { SUPER_ADMIN_SLUG } from '@aikit/admin-rbac'

export const testUser = {
  email: 'dev@payloadcms.com',
  password: 'test',
}

/**
 * Seeds a test user for e2e admin tests.
 */
export async function seedTestUser(): Promise<void> {
  const payload = await getPayload({ config })

  // Delete existing test user if any
  await payload.delete({
    collection: 'users',
    where: {
      email: {
        equals: testUser.email,
      },
    },
    overrideAccess: true,
  })

  const superAdmin = await payload.find({
    collection: 'roles' as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: {
      slug: {
        equals: SUPER_ADMIN_SLUG,
      },
    },
  })

  await payload.create({
    collection: 'users',
    data: {
      ...testUser,
      roles: superAdmin.docs[0] ? [superAdmin.docs[0].id] : [],
    },
    overrideAccess: true,
  })
}

/**
 * Cleans up test user after tests
 */
export async function cleanupTestUser(): Promise<void> {
  const payload = await getPayload({ config })

  await payload.delete({
    collection: 'users',
    where: {
      email: {
        equals: testUser.email,
      },
    },
    overrideAccess: true,
  })
}
