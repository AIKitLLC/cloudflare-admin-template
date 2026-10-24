// @vitest-environment node
import {
  createLocalReq,
  getPayload,
  type CollectionSlug,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ensureRbacCoverage, uncoveredCollectionSlugs } from '@/access/ensure-rbac-coverage'
import { exportCollection } from '@/access/export/create-export-endpoint'
import { registerRowScopeContributor } from '@/access/extensions'
import { grantEndpoint } from '@/rbac/endpoints/matrix-handlers'
import {
  FULL_ACCESS_ASSIGNMENT_ERROR,
  FULL_ACCESS_FLAG_ERROR,
  LAST_FULL_ACCESS_ERROR,
  OWN_ROLE_GRANT_ERROR,
  SUBSET_ASSIGNMENT_ERROR,
  SUBSET_GRANT_ERROR,
  UNCONDITIONAL_GRANT_ERROR,
} from '@/rbac/guards/privilege-errors'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/access/privilege/privilege-context'
import { seedRbac } from '@/rbac/seed/seed-rbac'
import {
  markUpgradePromotionDone,
  readUpgradePromotionDone,
  writeCatalogFingerprint,
} from '@/rbac/seed/rbac-state'
import { setRoleGrant } from '@/rbac/matrix/set-role-grant'

let payload: Payload
const stamp = Date.now()
const createdUserIds: Array<number | string> = []
const createdRoleIds: Array<number | string> = []

describe('RBAC privilege boundaries', () => {
  beforeAll(async () => {
    const { default: config } = await import('@/payload.config')
    payload = await getPayload({ config })
  }, 120000)

  afterAll(async () => {
    if (!payload) return
    if (createdUserIds.length > 0) {
      await payload.delete({
        collection: 'users',
        where: { id: { in: createdUserIds } },
        overrideAccess: true,
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
    }
    if (createdRoleIds.length > 0) {
      await payload.delete({
        collection: 'role-permissions' as CollectionSlug,
        where: { role: { in: createdRoleIds } },
        overrideAccess: true,
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
      await payload.delete({
        collection: 'roles' as CollectionSlug,
        where: { id: { in: createdRoleIds } },
        overrideAccess: true,
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
    }
  }, 120000)

  it('refuses a limited admin creating a full-access role', async () => {
    const role = await createRole(`flag-${stamp}`)
    await grant(role.id, 'roles:create')
    await grant(role.id, 'roles:writeField:name')
    await grant(role.id, 'roles:writeField:slug')
    await grant(role.id, 'roles:writeField:grantsFullAccess')
    const user = await createUser(`rbac-flag-${stamp}@example.com`, [role.id])

    await expect(
      payload.create({
        collection: 'roles' as CollectionSlug,
        data: {
          name: `Escalated ${stamp}`,
          slug: `escalated-${stamp}`,
          grantsFullAccess: true,
        },
        overrideAccess: false,
        user,
      }),
    ).rejects.toThrow(FULL_ACCESS_FLAG_ERROR)
  })

  it('refuses a limited admin assigning a full-access role', async () => {
    const role = await createRole(`assign-${stamp}`)
    await grant(role.id, 'users:update')
    await grant(role.id, 'users:writeField:roles')
    const user = await createUser(`rbac-assign-${stamp}@example.com`, [role.id])
    const superAdmin = await findSuperAdminRole()

    await expect(
      payload.update({
        collection: 'users',
        id: user.id,
        data: { roles: [role.id, superAdmin.id] },
        overrideAccess: false,
        user,
      }),
    ).rejects.toThrow(FULL_ACCESS_ASSIGNMENT_ERROR)

    const fresh = await payload.findByID({
      collection: 'users',
      id: user.id,
      overrideAccess: true,
    })
    expect(roleIds(fresh.roles)).toEqual([String(role.id)])
  })

  it('refuses grant changes on a role the actor holds, including the matrix route', async () => {
    const ownRole = await createRole(`own-${stamp}`)
    const otherRole = await createRole(`other-${stamp}`)
    await grant(ownRole.id, 'role-permissions:create')
    await grant(ownRole.id, 'role-permissions:update')
    await grant(ownRole.id, 'role-permissions:writeField:role')
    await grant(ownRole.id, 'role-permissions:writeField:permission')
    await grant(ownRole.id, 'role-permissions:writeField:granted')
    await grant(ownRole.id, 'media:read')
    const user = await createUser(`rbac-own-grant-${stamp}@example.com`, [ownRole.id])
    const permissionId = await permissionIdFor('media:read')

    await expect(
      payload.create({
        collection: 'role-permissions' as CollectionSlug,
        data: {
          role: ownRole.id,
          permission: permissionId,
          granted: true,
        },
        overrideAccess: false,
        user,
      }),
    ).rejects.toThrow(OWN_ROLE_GRANT_ERROR)

    const ownResponse = await grantEndpoint.handler(
      await localReq(user, { roleId: ownRole.id, permissionId, granted: true }),
    )
    expect(ownResponse.status).toBe(403)
    expect(await ownResponse.json()).toMatchObject({ error: OWN_ROLE_GRANT_ERROR })

    const otherResponse = await grantEndpoint.handler(
      await localReq(user, { roleId: otherRole.id, permissionId, granted: true }),
    )
    expect(otherResponse.status).toBe(200)

    const broader = await permissionIdFor('users:delete')
    const subsetResponse = await grantEndpoint.handler(
      await localReq(user, { roleId: otherRole.id, permissionId: broader, granted: true }),
    )
    expect(subsetResponse.status).toBe(403)
    expect(await subsetResponse.json()).toMatchObject({ error: SUBSET_GRANT_ERROR })

    const missing = await grantEndpoint.handler(
      await localReq(user, { roleId: otherRole.id, permissionId: 999999999, granted: true }),
    )
    expect(missing.status).toBe(404)
  })

  it('requires unconditional create and update before the matrix can write', async () => {
    const role = await createRole(`where-${stamp}`)
    await grant(role.id, 'role-permissions:create')
    await grant(role.id, 'role-permissions:update')
    const user = await createUser(`rbac-where-${stamp}@example.com`, [role.id])
    const permissionId = await permissionIdFor('media:delete')
    const unregister = registerRowScopeContributor(async (context) => {
      if (
        context.collectionSlug === 'role-permissions' &&
        (context.action === 'create' || context.action === 'update')
      ) {
        return { id: { equals: -1 } }
      }
      return undefined
    })
    try {
      const response = await grantEndpoint.handler(
        await localReq(user, { roleId: role.id, permissionId, granted: false }),
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: UNCONDITIONAL_GRANT_ERROR })
    } finally {
      unregister()
    }
  })

  it('N existing users, no roles -> only the first becomes Super Admin', async () => {
    const superAdmin = await findSuperAdminRole()
    for (let index = 0; index < 3; index += 1) {
      await createUser(`rbac-upgrade-${index}-${stamp}@example.com`, [])
    }
    const before = await payload.find({
      collection: 'users',
      depth: 0,
      overrideAccess: true,
      pagination: false,
    })
    const snapshot = before.docs.map((doc) => ({
      id: doc.id,
      createdAt: (doc as { createdAt?: string | null }).createdAt ?? null,
      roles: (doc as { roles?: unknown }).roles,
    }))
    expect(snapshot.length).toBeGreaterThanOrEqual(3)
    const info = payload.logger.info.bind(payload.logger)
    const logs: unknown[] = []
    payload.logger.info = ((entry: unknown, msg?: string, ...args: unknown[]) => {
      logs.push(entry)
      return info(entry, msg, ...args)
    }) as typeof payload.logger.info
    try {
      for (const user of snapshot) {
        await payload.update({
          collection: 'users',
          id: user.id,
          data: { roles: [] },
          overrideAccess: true,
          context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
        })
      }
      await payload.delete({
        collection: 'payload-kv' as CollectionSlug,
        where: { key: { equals: 'rbac:upgrade_promotion' } },
        overrideAccess: true,
      })
      expect(await readUpgradePromotionDone(payload)).toBe(false)

      await seedRbac(payload)

      const after = await payload.find({
        collection: 'users',
        depth: 0,
        overrideAccess: true,
        pagination: false,
      })
      const promoted = after.docs.filter((doc) =>
        roleIds((doc as { roles?: unknown }).roles).includes(String(superAdmin.id)),
      )
      expect(promoted).toHaveLength(1)
      const winner = promoted[0] as {
        id: number | string
        createdAt?: string | null
        email?: string
      }
      const expected = [...snapshot].sort((left, right) => {
        const created = (left.createdAt ?? '').localeCompare(right.createdAt ?? '')
        if (created !== 0) return created
        return Number(left.id) - Number(right.id)
      })[0]
      expect(String(winner.id)).toBe(String(expected.id))
      const untouched = after.docs.filter((doc) => String(doc.id) !== String(winner.id))
      expect(untouched.length).toBeGreaterThanOrEqual(2)
      for (const doc of untouched) {
        expect(roleIds((doc as { roles?: unknown }).roles)).toEqual([])
      }
      expect(await readUpgradePromotionDone(payload)).toBe(true)
      expect(logs).toContainEqual(
        expect.objectContaining({
          msg: 'Promoted the earliest existing user to super-admin',
          userId: winner.id,
          email: winner.email ?? null,
        }),
      )
    } finally {
      payload.logger.info = info as typeof payload.logger.info
      for (const user of snapshot) {
        await payload.update({
          collection: 'users',
          id: user.id,
          data: { roles: Array.isArray(user.roles) ? user.roles : [] },
          overrideAccess: true,
          context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
        })
      }
      await markUpgradePromotionDone(payload)
    }
  })

  it('does not mass-promote after the last full-access assignment is removed outside the API', async () => {
    const superAdmin = await findSuperAdminRole()
    const holders = await payload.find({
      collection: 'users',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      where: { roles: { in: [superAdmin.id] } },
    })
    const previous = holders.docs.map((doc) => ({
      id: doc.id,
      roles: (doc as { roles?: unknown }).roles,
    }))
    const keeper = await createUser(`rbac-keeper-${stamp}@example.com`, [superAdmin.id])
    try {
      for (const holder of previous) {
        await payload.update({
          collection: 'users',
          id: holder.id,
          data: { roles: [] },
          overrideAccess: true,
          context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
        })
      }
      await expect(
        payload.update({
          collection: 'users',
          id: keeper.id,
          data: { roles: [] },
          overrideAccess: false,
          user: keeper,
        }),
      ).rejects.toThrow(LAST_FULL_ACCESS_ERROR)

      await payload.update({
        collection: 'users',
        id: keeper.id,
        data: { roles: [] },
        overrideAccess: true,
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
      await seedRbac(payload)
      const fresh = await payload.findByID({
        collection: 'users',
        id: keeper.id,
        overrideAccess: true,
      })
      expect(roleIds(fresh.roles)).toEqual([])
    } finally {
      for (const holder of previous) {
        await payload.update({
          collection: 'users',
          id: holder.id,
          data: { roles: holder.roles as number[] },
          overrideAccess: true,
          context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
        })
      }
    }
  })

  it('survives two seeds racing on the catalog unique indexes', async () => {
    const before = await payload.count({
      collection: 'permissions' as CollectionSlug,
      overrideAccess: true,
    })
    await writeCatalogFingerprint(payload, 'stale-fingerprint')
    await Promise.all([seedRbac(payload), seedRbac(payload)])
    const after = await payload.count({
      collection: 'permissions' as CollectionSlug,
      overrideAccess: true,
    })
    expect(after.totalDocs).toBe(before.totalDocs)
  })

  it('denies a collection that was registered without withRbac', async () => {
    expect(uncoveredCollectionSlugs([{ slug: 'notes' }])).toEqual(['notes'])
    const [notes] = ensureRbacCoverage([
      {
        slug: `notes-${stamp}`,
        fields: [{ name: 'title', type: 'text' }],
      },
    ])
    const stranger = await createUser(`rbac-notes-${stamp}@example.com`, [])
    const decision = await notes.access?.read?.({
      req: await localReq(stranger),
    })
    expect(decision).toBe(false)
  })

  it('refuses granting or assigning permissions the actor does not hold', async () => {
    const role = await createRole(`subset-${stamp}`)
    await grant(role.id, 'roles:create')
    await grant(role.id, 'roles:writeField:name')
    await grant(role.id, 'roles:writeField:slug')
    await grant(role.id, 'role-permissions:create')
    await grant(role.id, 'role-permissions:writeField:role')
    await grant(role.id, 'role-permissions:writeField:permission')
    await grant(role.id, 'role-permissions:writeField:granted')
    await grant(role.id, 'users:update')
    await grant(role.id, 'users:writeField:roles')
    await grant(role.id, 'media:read')
    const user = await createUser(`rbac-subset-${stamp}@example.com`, [role.id])
    const broader = await createRole(`broader-${stamp}`)
    await grant(broader.id, 'users:delete')
    const empty = await createRole(`empty-${stamp}`)
    const usersDelete = await permissionIdFor('users:delete')

    await expect(
      payload.create({
        collection: 'role-permissions' as CollectionSlug,
        data: { role: empty.id, permission: usersDelete, granted: true },
        overrideAccess: false,
        user,
      }),
    ).rejects.toThrow(SUBSET_GRANT_ERROR)

    await expect(
      payload.update({
        collection: 'users',
        id: user.id,
        data: { roles: [role.id, broader.id] },
        overrideAccess: false,
        user,
      }),
    ).rejects.toThrow(SUBSET_ASSIGNMENT_ERROR)

    await payload.update({
      collection: 'users',
      id: user.id,
      data: { roles: [role.id, empty.id] },
      overrideAccess: false,
      user,
    })
    const fresh = await payload.findByID({
      collection: 'users',
      id: user.id,
      overrideAccess: true,
    })
    expect(roleIds(fresh.roles).sort()).toEqual([String(role.id), String(empty.id)].sort())
  })

  it('refuses deleting the full-access role that still holds the last assignment', async () => {
    const superAdmin = await findSuperAdminRole()
    const custom = await payload.create({
      collection: 'roles' as CollectionSlug,
      data: {
        name: `Full ${stamp}`,
        slug: `full-${stamp}`,
        grantsFullAccess: true,
      },
      overrideAccess: true,
      context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
    })
    createdRoleIds.push(custom.id)
    const holders = await payload.find({
      collection: 'users',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      where: { roles: { in: [superAdmin.id] } },
    })
    const previous = holders.docs.map((doc) => ({
      id: doc.id,
      roles: (doc as { roles?: unknown }).roles,
    }))
    const keeper = await createUser(`rbac-full-role-${stamp}@example.com`, [Number(custom.id)])
    try {
      for (const holder of previous) {
        await payload.update({
          collection: 'users',
          id: holder.id,
          data: { roles: [] },
          overrideAccess: true,
          context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
        })
      }
      await expect(
        payload.delete({
          collection: 'roles' as CollectionSlug,
          id: custom.id,
          overrideAccess: false,
          user: keeper,
        }),
      ).rejects.toThrow(LAST_FULL_ACCESS_ERROR)
      const stillThere = await payload.findByID({
        collection: 'roles' as CollectionSlug,
        id: custom.id,
        overrideAccess: true,
      })
      expect(stillThere.id).toBe(custom.id)
    } finally {
      for (const holder of previous) {
        await payload.update({
          collection: 'users',
          id: holder.id,
          data: { roles: holder.roles as number[] },
          overrideAccess: true,
          context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
        })
      }
    }
  })

  it('does not leak auth secrets from the export route', async () => {
    const superAdmin = await findSuperAdminRole()
    const admin = await createUser(`rbac-export-admin-${stamp}@example.com`, [superAdmin.id])
    const response = await exportCollection(await localReq(admin), 'users')
    expect(response.status).toBe(200)
    const csv = await response.text()
    const header = csv.split('\n')[0]?.split(',') ?? []
    for (const secret of [
      'hash',
      'salt',
      'resetPasswordToken',
      'resetPasswordExpiration',
      'loginAttempts',
      'lockUntil',
      'sessions',
    ]) {
      expect(header).not.toContain(secret)
    }
    const stored = await readAuthSecret(admin.email)
    if (stored?.hash) {
      expect(csv).not.toContain(stored.hash)
    }
    if (stored?.salt) {
      expect(csv).not.toContain(stored.salt)
    }
  })
})

async function findSuperAdminRole(): Promise<{ id: number }> {
  const result = await payload.find({
    collection: 'roles' as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { slug: { equals: 'super-admin' } },
  })
  if (!result.docs[0]) {
    throw new Error('super-admin role was not seeded')
  }
  return { id: Number(result.docs[0].id) }
}

async function createRole(slug: string): Promise<{ id: number }> {
  const role = await payload.create({
    collection: 'roles' as CollectionSlug,
    data: { name: slug, slug, grantsFullAccess: false },
    overrideAccess: true,
  })
  createdRoleIds.push(role.id)
  return { id: Number(role.id) }
}

async function createUser(email: string, roles: number[]): Promise<{ id: number; email: string }> {
  const user = await payload.create({
    collection: 'users',
    data: { role: 'admin', email, password: 'test-password-123', roles },
    overrideAccess: true,
    context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
  })
  createdUserIds.push(user.id)
  return { id: Number(user.id), email: user.email }
}

async function grant(roleId: number, key: string): Promise<void> {
  await setRoleGrant(payload, {
    roleId,
    permissionId: await permissionIdFor(key),
    granted: true,
  })
}

async function permissionIdFor(key: string): Promise<number> {
  const permission = await payload.find({
    collection: 'permissions' as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { key: { equals: key } },
  })
  if (!permission.docs[0]) {
    throw new Error(`Missing permission ${key}`)
  }
  return Number(permission.docs[0].id)
}

function roleIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (typeof item === 'number' || typeof item === 'string') return String(item)
    return String((item as { id: number | string }).id)
  })
}

async function localReq(
  user: { id: number | string; email?: string },
  data?: unknown,
): Promise<PayloadRequest> {
  const req = await createLocalReq({ user: user as PayloadRequest['user'] }, payload)
  if (data) {
    req.json = async () => data
  }
  return req
}

async function readAuthSecret(email: string): Promise<{ hash?: string; salt?: string } | null> {
  const adapter = payload.db as {
    client?: {
      prepare: (query: string) => {
        bind: (...values: unknown[]) => {
          first: <T>() => Promise<T | null>
        }
      }
    }
  }
  return (
    adapter.client
      ?.prepare(`SELECT hash, salt FROM users WHERE email = ?`)
      .bind(email)
      .first<{ hash?: string; salt?: string }>() ?? null
  )
}
