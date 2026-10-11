// @vitest-environment node
import {
  createLocalReq,
  getPayload,
  type CollectionSlug,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { registerBeforeGrantGate, registerRowScopeContributor } from '@/access/extensions'
import { exportCollection } from '@/access/export/create-export-endpoint'
import { grantEndpoint } from '@/rbac/endpoints/matrix-handlers'
import { loadPermissionMatrix } from '@/rbac/matrix/load-permission-matrix'
import { setRoleGrant } from '@/rbac/matrix/set-role-grant'
import { syncPermissionCatalog } from '@/rbac/seed/sync-permission-catalog'

let payload: Payload
const stamp = Date.now()
const createdUserIds: Array<number | string> = []
const createdRoleIds: Array<number | string> = []
const createdOrganizationIds: Array<number | string> = []

describe('RBAC access', () => {
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
      })
    }
    if (createdRoleIds.length > 0) {
      await payload.delete({
        collection: 'role-permissions' as CollectionSlug,
        where: { role: { in: createdRoleIds } },
        overrideAccess: true,
      })
      await payload.delete({
        collection: 'roles' as CollectionSlug,
        where: { id: { in: createdRoleIds } },
        overrideAccess: true,
      })
    }
    if (createdOrganizationIds.length > 0) {
      await payload.delete({
        collection: 'organizations' as CollectionSlug,
        where: { id: { in: createdOrganizationIds } },
        overrideAccess: true,
      })
    }
  }, 120000)

  it('syncs collection and field permissions and keeps internal collections out', async () => {
    const permissions = await payload.find({
      collection: 'permissions' as CollectionSlug,
      depth: 0,
      overrideAccess: true,
      pagination: false,
    })
    const keys = new Set(permissions.docs.map((doc) => (doc as { key?: string }).key))
    expect(keys.has('media:read')).toBe(true)
    expect(keys.has('media:export')).toBe(true)
    expect(keys.has('media:readField:alt')).toBe(true)
    expect(keys.has('media:writeField:alt')).toBe(true)
    expect(keys.has('users:readField:roles')).toBe(true)
    expect(keys.has('users:delete')).toBe(true)
    expect([...keys].some((key) => key?.startsWith('payload-'))).toBe(false)

    const stale = await payload.create({
      collection: 'permissions' as CollectionSlug,
      data: {
        key: `stale-${stamp}:read`,
        label: 'Stale',
        collectionSlug: 'stale',
        action: 'read',
        active: true,
      },
      overrideAccess: true,
    })
    await syncPermissionCatalog(payload)
    const refreshed = await payload.findByID({
      collection: 'permissions' as CollectionSlug,
      id: stale.id,
      overrideAccess: true,
    })
    expect((refreshed as { active?: boolean }).active).toBe(false)
  })

  it('lets a super-admin bypass the matrix and denies a user with no roles', async () => {
    const superAdminRole = await findSuperAdminRole()
    const admin = await createUser(`rbac-admin-${stamp}@example.com`, [superAdminRole.id])
    const stranger = await createUser(`rbac-stranger-${stamp}@example.com`, [])

    const created = await payload.create({
      collection: 'roles' as CollectionSlug,
      data: {
        name: `Temp ${stamp}`,
        slug: `temp-${stamp}`,
      },
      overrideAccess: false,
      user: admin,
    })
    createdRoleIds.push(created.id)

    await expect(
      payload.find({
        collection: 'roles' as CollectionSlug,
        overrideAccess: false,
        user: stranger,
      }),
    ).rejects.toThrow(/not allowed/i)
  })

  it('enforces collection actions and field read and write permissions', async () => {
    const readerRole = await createRole(`reader-${stamp}`)
    await grant(readerRole.id, 'users:read')
    await grant(readerRole.id, 'users:readField:email')
    const editorRole = await createRole(`editor-${stamp}`)
    await grant(editorRole.id, 'users:read')
    await grant(editorRole.id, 'users:update')
    await grant(editorRole.id, 'users:readField:email')
    await grant(editorRole.id, 'users:writeField:email')

    const organizationId = await createOrganization(`rbac-shared-${stamp}`)
    const subject = await createUser(`rbac-subject-${stamp}@example.com`, [], organizationId)
    const reader = await createUser(
      `rbac-reader-${stamp}@example.com`,
      [readerRole.id],
      organizationId,
    )
    const editor = await createUser(
      `rbac-editor-${stamp}@example.com`,
      [editorRole.id],
      organizationId,
    )

    const visible = await payload.findByID({
      collection: 'users',
      id: subject.id,
      overrideAccess: false,
      user: reader,
    })
    expect(visible.email).toBe(subject.email)
    expect(visible.roles).toBeUndefined()

    await expect(
      payload.create({
        collection: 'roles' as CollectionSlug,
        data: { name: 'nope', slug: `nope-${stamp}` },
        overrideAccess: false,
        user: reader,
      }),
    ).rejects.toThrow(/not allowed/i)

    const nextEmail = `rbac-renamed-${stamp}@example.com`
    await payload.update({
      collection: 'users',
      id: subject.id,
      data: {
        email: nextEmail,
        roles: [readerRole.id],
      },
      overrideAccess: false,
      user: editor,
    })
    const updated = await payload.findByID({
      collection: 'users',
      id: subject.id,
      overrideAccess: true,
    })
    expect(updated.email).toBe(nextEmail)
    expect(roleIds(updated.roles)).toEqual([])
  })

  it('allows anonymous media reads and still requires a grant for signed-in users', async () => {
    const anonymous = await payload.find({
      collection: 'media',
      overrideAccess: false,
    })
    expect(anonymous.docs).toBeDefined()

    const role = await createRole(`media-denied-${stamp}`)
    await grant(role.id, 'users:read')
    const user = await createUser(`rbac-media-${stamp}@example.com`, [role.id])
    await expect(
      payload.find({
        collection: 'media',
        overrideAccess: false,
        user,
      }),
    ).rejects.toThrow(/not allowed/i)
  })

  it('exports only when export access is granted and honors field access', async () => {
    const role = await createRole(`exporter-${stamp}`)
    await grant(role.id, 'users:export')
    await grant(role.id, 'users:read')
    await grant(role.id, 'users:readField:email')
    const organizationId = await createOrganization(`rbac-export-org-${stamp}`)
    const hiddenRole = await createRole(`hidden-export-${stamp}`)
    const subject = await createUser(
      `rbac-export-subject-${stamp}@example.com`,
      [hiddenRole.id],
      organizationId,
    )
    const user = await createUser(`rbac-export-${stamp}@example.com`, [role.id], organizationId)
    const req = await localReq(user)
    const response = await exportCollection(req, 'users')
    expect(response.status).toBe(200)
    const csv = await response.text()
    expect(csv).toContain(user.email)
    expect(csv).toContain(subject.email)
    const subjectRow = csv.split('\n').find((line) => line.includes(subject.email))
    expect(subjectRow).toBeTruthy()
    expect(subjectRow).not.toContain(`[${hiddenRole.id}]`)

    const deniedRole = await createRole(`export-denied-${stamp}`)
    await grant(deniedRole.id, 'users:read')
    const deniedUser = await createUser(`rbac-export-denied-${stamp}@example.com`, [deniedRole.id])
    const deniedResponse = await exportCollection(await localReq(deniedUser), 'users')
    expect(deniedResponse.status).toBe(403)
  })

  it('rejects matrix edits without update access and records a grant for a normal role', async () => {
    const role = await createRole(`matrix-${stamp}`)
    await grant(role.id, 'role-permissions:read')
    const reader = await createUser(`rbac-matrix-${stamp}@example.com`, [role.id])
    const readResponse = await grantEndpoint.handler(
      await localReq(reader, { roleId: role.id, permissionId: 1, granted: true }),
    )
    expect(readResponse.status).toBe(403)

    const permission = await payload.find({
      collection: 'permissions' as CollectionSlug,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { key: { equals: 'media:update' } },
    })
    await setRoleGrant(payload, {
      roleId: role.id,
      permissionId: permission.docs[0].id,
      granted: true,
    })
    const matrix = await loadPermissionMatrix(payload)
    const media = matrix.groups.find((group) => group.collectionSlug === 'media')
    const updateRow = media?.rows.find((row) => row.key === 'media:update')
    expect(updateRow?.grantsByRoleId[String(role.id)]).toBe(true)
    expect(matrix.roles.some((item) => item.slug === 'super-admin' && item.grantsFullAccess)).toBe(
      true,
    )
  })

  it('lets a policy gate deny full access and lets row scope narrow a grant', async () => {
    const superAdminRole = await findSuperAdminRole()
    const admin = await createUser(`rbac-policy-${stamp}@example.com`, [superAdminRole.id])
    const unregisterPolicy = registerBeforeGrantGate({
      name: 'test-deny',
      evaluate: async (context) => (context.action === 'delete' ? false : undefined),
    })
    try {
      await expect(
        payload.delete({
          collection: 'roles' as CollectionSlug,
          id: superAdminRole.id,
          overrideAccess: false,
          user: admin,
        }),
      ).rejects.toThrow(/not allowed/i)
    } finally {
      unregisterPolicy()
    }

    const unregisterScope = registerRowScopeContributor(async (context) => {
      if (context.collectionSlug === 'roles' && context.action === 'read') {
        return { slug: { equals: 'missing-role' } }
      }
      return undefined
    })
    try {
      const scopedRole = await createRole(`scoped-${stamp}`)
      await grant(scopedRole.id, 'roles:read')
      await grant(scopedRole.id, 'roles:readField:name')
      await grant(scopedRole.id, 'roles:readField:slug')
      const scopedUser = await createUser(`rbac-scoped-${stamp}@example.com`, [scopedRole.id])
      const scoped = await payload.find({
        collection: 'roles' as CollectionSlug,
        overrideAccess: false,
        user: scopedUser,
      })
      expect(scoped.docs).toEqual([])

      const unscoped = await payload.find({
        collection: 'roles' as CollectionSlug,
        overrideAccess: false,
        user: admin,
      })
      expect(unscoped.docs.length).toBeGreaterThan(0)
    } finally {
      unregisterScope()
    }
  })

  it('keeps users from granting themselves a role', async () => {
    const role = await createRole(`self-${stamp}`)
    await grant(role.id, 'users:read')
    await grant(role.id, 'users:readField:email')
    const user = await createUser(`rbac-self-${stamp}@example.com`, [role.id])
    const superAdminRole = await findSuperAdminRole()
    await payload.update({
      collection: 'users',
      id: user.id,
      data: { roles: [superAdminRole.id] },
      overrideAccess: false,
      user,
    })
    const fresh = await payload.findByID({
      collection: 'users',
      id: user.id,
      overrideAccess: true,
    })
    expect(roleIds(fresh.roles)).toEqual([String(role.id)])
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
    data: {
      name: slug,
      slug,
      grantsFullAccess: false,
    },
    overrideAccess: true,
  })
  createdRoleIds.push(role.id)
  return { id: Number(role.id) }
}

async function createOrganization(slug: string): Promise<number> {
  const organization = await payload.create({
    collection: 'organizations' as CollectionSlug,
    data: { name: slug, slug },
    overrideAccess: true,
  })
  createdOrganizationIds.push(organization.id)
  return Number(organization.id)
}

async function createUser(
  email: string,
  roles: number[],
  organizationId?: number,
): Promise<{ id: number; email: string }> {
  const user = await payload.create({
    collection: 'users',
    data: {
      email,
      password: 'test-password-123',
      roles,
      ...(organizationId ? { organizations: [organizationId] } : {}),
    },
    overrideAccess: true,
  })
  createdUserIds.push(user.id)
  return { id: Number(user.id), email: user.email }
}

async function grant(roleId: number, key: string): Promise<void> {
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
  await setRoleGrant(payload, {
    roleId,
    permissionId: permission.docs[0].id,
    granted: true,
  })
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
