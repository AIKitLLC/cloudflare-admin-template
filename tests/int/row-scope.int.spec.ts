// @vitest-environment node
import { createLocalReq, type CollectionSlug, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { exportCollection } from '@/access/export/create-export-endpoint'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/rbac/guards/privilege-context'
import { SUPER_ADMIN_SLUG } from '@/access/constants'
import {
  SCOPE_ASSIGNMENT_ERROR,
  SCOPE_CYCLE_ERROR,
  SCOPE_GRANT_ERROR,
  SCOPE_NODE_ERROR,
  SCOPE_NODE_IN_USE_ERROR,
  SCOPE_RECORD_ERROR,
  SCOPE_ROLE_TARGET_ERROR,
  SCOPE_TARGET_KEYS_ERROR,
  SELF_SCOPE_ASSIGNMENT_ERROR,
} from '@/scope/errors'
import { loadEffectiveScope } from '@/scope/resolve/load-effective-scope'
import {
  BRANCHES_SLUG,
  DATA_CLASSES_SLUG,
  ORGANIZATIONS_SLUG,
  RECORDS_SLUG,
} from '@/scope/constants'
import {
  cleanupRowScopeFixture,
  grantKey,
  seedRowScopeFixture,
  type RowScopeFixture,
  type ScopeUser,
} from '../helpers/row-scope-fixture'

let payload: Payload
let fixture: RowScopeFixture
const extraUserIds: number[] = []

describe('row scope access', () => {
  beforeAll(async () => {
    const { openPayload } = await import('../helpers/row-scope-fixture')
    payload = await openPayload()
    fixture = await seedRowScopeFixture(payload, `${Date.now()}-local`)
  }, 120000)

  afterAll(async () => {
    if (!payload || !fixture) return
    fixture.userIds.push(...extraUserIds)
    await cleanupRowScopeFixture(payload, fixture)
  }, 120000)

  it('hides every scoped row from a granted user with no assignments', async () => {
    const visible = await findRecords(fixture.emptyUser)
    expect(visible.totalDocs).toBe(0)
  })

  it('lets full access read every organization and record', async () => {
    const admin = await createSuperAdmin()
    const records = await findRecords(admin)
    expect(recordIds(records)).toEqual(expect.arrayContaining(fixture.recordIds))
    const organizations = await payload.find({
      collection: ORGANIZATIONS_SLUG as CollectionSlug,
      overrideAccess: false,
      pagination: false,
      user: asUser(admin),
    })
    expect(organizations.totalDocs).toBeGreaterThanOrEqual(fixture.organizationIds.length)
  })

  it('inherits descendant organizations, implied branches, and grouped data classes', async () => {
    const visible = await findRecords(fixture.actor)
    expect(visible.totalDocs).toBe(3)
    expect(recordIds(visible).sort()).toEqual(
      [fixture.westRecordId, fixture.westSubRecordId, fixture.westChildRecordId].sort(),
    )
    const classes = await payload.find({
      collection: DATA_CLASSES_SLUG as CollectionSlug,
      overrideAccess: false,
      pagination: false,
      user: asUser(fixture.actor),
    })
    expect(docIds(classes).sort()).toEqual([fixture.sensitiveId, fixture.piiId].sort())
  })

  it('limits a branch assignment to that branch and still allows reading its organization', async () => {
    const visible = await findRecords(fixture.branchUser)
    expect(recordIds(visible)).toEqual([fixture.westSubRecordId])
    const organization = await payload.findByID({
      collection: ORGANIZATIONS_SLUG as CollectionSlug,
      id: fixture.westId,
      overrideAccess: false,
      user: asUser(fixture.branchUser),
    })
    expect(Number(organization.id)).toBe(fixture.westId)
    await expect(
      payload.update({
        collection: ORGANIZATIONS_SLUG as CollectionSlug,
        id: fixture.westId,
        data: { name: `Renamed ${fixture.stamp}` },
        overrideAccess: false,
        user: asUser(fixture.branchUser),
      }),
    ).rejects.toThrow()
  })

  it('paginates and counts only in-scope records', async () => {
    const page = await payload.find({
      collection: RECORDS_SLUG as CollectionSlug,
      limit: 1,
      page: 1,
      overrideAccess: false,
      user: asUser(fixture.actor),
    })
    expect(page.totalDocs).toBe(3)
    expect(page.docs).toHaveLength(1)
    expect(page.hasNextPage).toBe(true)
    expect(page.totalPages).toBe(3)
    const counted = await payload.count({
      collection: RECORDS_SLUG as CollectionSlug,
      overrideAccess: false,
      user: asUser(fixture.actor),
    })
    expect(counted.totalDocs).toBe(3)
  })

  it('exports only in-scope rows', async () => {
    const req = await createLocalReq({ user: asUser(fixture.actor) }, payload)
    const response = await exportCollection(req, RECORDS_SLUG)
    expect(response.status).toBe(200)
    const csv = await response.text()
    expect(csv).toContain(fixture.westTitle)
    expect(csv).toContain(fixture.westSubTitle)
    expect(csv).toContain(fixture.westChildTitle)
    expect(csv).not.toContain(fixture.eastTitle)
    expect(csv).not.toContain(fixture.publicTitle)
  })

  it('refuses cross-scope updates, deletes, and creates, and allows an in-scope write', async () => {
    await expect(
      payload.update({
        collection: RECORDS_SLUG as CollectionSlug,
        id: fixture.eastRecordId,
        data: { title: 'changed' },
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow()
    await expect(
      payload.delete({
        collection: RECORDS_SLUG as CollectionSlug,
        id: fixture.eastRecordId,
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow()
    const east = await payload.findByID({
      collection: RECORDS_SLUG,
      id: fixture.eastRecordId,
      overrideAccess: true,
    })
    expect(east.title).toBe(fixture.eastTitle)

    await expect(
      payload.update({
        collection: RECORDS_SLUG as CollectionSlug,
        id: fixture.westRecordId,
        data: { organization: fixture.eastId },
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow(SCOPE_RECORD_ERROR)
    await expect(
      payload.create({
        collection: RECORDS_SLUG as CollectionSlug,
        data: {
          title: `Outside ${fixture.stamp}`,
          organization: fixture.eastId,
          branch: fixture.eastBranchId,
          dataClass: fixture.piiId,
        },
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow(SCOPE_RECORD_ERROR)

    const created = await payload.create({
      collection: RECORDS_SLUG as CollectionSlug,
      data: {
        title: `Inside ${fixture.stamp}`,
        organization: fixture.westId,
        branch: fixture.westMainBranchId,
        dataClass: fixture.piiId,
      },
      overrideAccess: false,
      user: asUser(fixture.actor),
    })
    fixture.recordIds.push(Number(created.id))
    const renamed = `Renamed west ${fixture.stamp}`
    await payload.update({
      collection: RECORDS_SLUG as CollectionSlug,
      id: fixture.westRecordId,
      data: { title: renamed },
      overrideAccess: false,
      user: asUser(fixture.actor),
    })
    const stored = await payload.findByID({
      collection: RECORDS_SLUG,
      id: fixture.westRecordId,
      overrideAccess: true,
    })
    expect(stored.title).toBe(renamed)
  })

  it('rejects cycles and roots, and sees a child created in the same request', async () => {
    await expect(
      payload.update({
        collection: ORGANIZATIONS_SLUG as CollectionSlug,
        id: fixture.westId,
        data: { parent: fixture.westChildId },
        overrideAccess: true,
      }),
    ).rejects.toThrow(SCOPE_CYCLE_ERROR)
    await expect(
      payload.create({
        collection: ORGANIZATIONS_SLUG as CollectionSlug,
        data: { name: `Root ${fixture.stamp}`, slug: `root-${fixture.stamp}` },
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow(SCOPE_NODE_ERROR)

    const req = await createLocalReq({ user: asUser(fixture.actor) }, payload)
    const created = await payload.create({
      collection: ORGANIZATIONS_SLUG as CollectionSlug,
      data: {
        name: `Same request ${fixture.stamp}`,
        slug: `same-${fixture.stamp}`,
        parent: fixture.westId,
      },
      overrideAccess: false,
      req,
      user: asUser(fixture.actor),
    })
    const visible = await payload.find({
      collection: ORGANIZATIONS_SLUG as CollectionSlug,
      depth: 0,
      overrideAccess: false,
      req,
      user: asUser(fixture.actor),
      where: { id: { equals: created.id } },
    })
    expect(visible.docs).toHaveLength(1)
    await payload.delete({
      collection: ORGANIZATIONS_SLUG as CollectionSlug,
      id: created.id,
      overrideAccess: true,
      context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
    })
    await expect(
      payload.delete({
        collection: ORGANIZATIONS_SLUG as CollectionSlug,
        id: fixture.westId,
        overrideAccess: true,
      }),
    ).rejects.toThrow(SCOPE_NODE_IN_USE_ERROR)
  })

  it('reads the scope catalog once per request', async () => {
    const req = await createLocalReq({ user: asUser(fixture.actor) }, payload)
    let reads = 0
    const original = payload.find.bind(payload)
    const spy = vi.spyOn(payload, 'find').mockImplementation(async (args) => {
      if (
        args.collection === ORGANIZATIONS_SLUG ||
        args.collection === BRANCHES_SLUG ||
        args.collection === DATA_CLASSES_SLUG
      ) {
        reads += 1
      }
      return original(args)
    })
    try {
      await loadEffectiveScope(req)
      await loadEffectiveScope(req)
      expect(reads).toBe(3)
    } finally {
      spy.mockRestore()
    }
  })

  it('hides and refuses writes to users outside the actor scope', async () => {
    const visible = await payload.find({
      collection: 'users',
      depth: 0,
      overrideAccess: false,
      pagination: false,
      user: asUser(fixture.actor),
    })
    const visibleIds = visible.docs.map((doc) => Number(doc.id))
    expect(visibleIds).toContain(fixture.actor.id)
    expect(visibleIds).toContain(fixture.childUser.id)
    expect(visibleIds).toContain(fixture.emptyUser.id)
    expect(visibleIds).toContain(fixture.branchUser.id)
    expect(visibleIds).not.toContain(fixture.eastUser.id)
    await expect(
      payload.findByID({
        collection: 'users',
        id: fixture.eastUser.id,
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow()
    await expect(
      payload.update({
        collection: 'users',
        id: fixture.eastUser.id,
        data: { password: 'taken-over-password' },
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow()
    await expect(
      payload.delete({
        collection: 'users',
        id: fixture.eastUser.id,
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow()
    const exported = await exportCollection(
      await createLocalReq({ user: asUser(fixture.actor) }, payload),
      'users',
    )
    expect(exported.status).toBe(200)
    const csv = await exported.text()
    expect(csv).toContain(fixture.childUser.email)
    expect(csv).not.toContain(fixture.eastUser.email)
  })

  it('refuses self scope edits, wider assignments, wider role targets, and wider grant holders', async () => {
    await expect(
      payload.update({
        collection: 'users',
        id: fixture.actor.id,
        data: { organizations: [fixture.westId, fixture.eastId] },
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow(SELF_SCOPE_ASSIGNMENT_ERROR)

    await expect(
      payload.update({
        collection: 'users',
        id: fixture.childUser.id,
        data: { organizations: [fixture.westChildId, fixture.eastId] },
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow(SCOPE_ASSIGNMENT_ERROR)

    const both = await payload.create({
      collection: 'users',
      data: {
        email: `scope-both-${fixture.stamp}@example.com`,
        password: 'test-password-123',
        organizations: [fixture.eastId, fixture.westId],
        dataClasses: [fixture.piiId],
      },
      overrideAccess: true,
      context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
    })
    extraUserIds.push(Number(both.id))
    await expect(
      payload.findByID({
        collection: 'users',
        id: both.id,
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow()
    await payload.update({
      collection: 'users',
      id: both.id,
      data: { organizations: [fixture.westId] },
      overrideAccess: true,
      user: asUser(fixture.actor),
    })
    const preserved = await payload.findByID({
      collection: 'users',
      id: both.id,
      depth: 0,
      overrideAccess: true,
    })
    expect(relationList(preserved.organizations).sort()).toEqual(
      [String(fixture.eastId), String(fixture.westId)].sort(),
    )

    const recordsUpdate = await permissionId('records:update')
    await expect(
      payload.create({
        collection: 'role-permissions' as CollectionSlug,
        data: { role: fixture.outsideRoleId, permission: recordsUpdate, granted: true },
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow(SCOPE_GRANT_ERROR)
    await payload.create({
      collection: 'role-permissions' as CollectionSlug,
      data: { role: fixture.insideRoleId, permission: recordsUpdate, granted: true },
      overrideAccess: false,
      user: asUser(fixture.actor),
    })

    await expect(
      payload.update({
        collection: 'users',
        id: fixture.eastUser.id,
        data: { roles: [fixture.outsideRoleId, fixture.freshRoleId] },
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow()
    await expect(
      payload.update({
        collection: 'users',
        id: fixture.eastUser.id,
        data: { roles: [fixture.outsideRoleId, fixture.freshRoleId] },
        overrideAccess: true,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow(SCOPE_ROLE_TARGET_ERROR)
    await payload.update({
      collection: 'users',
      id: fixture.childUser.id,
      data: { roles: [fixture.insideRoleId, fixture.freshRoleId] },
      overrideAccess: false,
      user: asUser(fixture.actor),
    })
    await grantKey(payload, fixture.insideRoleId, 'media:read')
    await expect(
      payload.update({
        collection: 'users',
        id: fixture.childUser.id,
        data: { organizations: [fixture.westChildId, fixture.westId] },
        overrideAccess: false,
        user: asUser(fixture.actor),
      }),
    ).rejects.toThrow(SCOPE_TARGET_KEYS_ERROR)
  })
})

function asUser(user: ScopeUser) {
  return {
    id: user.id,
    email: user.email,
    collection: 'users' as const,
    updatedAt: '',
    createdAt: '',
  }
}

function findRecords(user: ScopeUser) {
  return payload.find({
    collection: RECORDS_SLUG as CollectionSlug,
    depth: 0,
    overrideAccess: false,
    pagination: false,
    user: asUser(user),
  })
}

function recordIds(result: { docs: Array<{ id: number | string }> }): number[] {
  return result.docs.map((doc) => Number(doc.id))
}

function docIds(result: { docs: Array<{ id: number | string }> }): number[] {
  return result.docs.map((doc) => Number(doc.id))
}

function relationList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) =>
    typeof item === 'object' && item && 'id' in item ? String(item.id) : String(item),
  )
}

async function createSuperAdmin(): Promise<ScopeUser> {
  const role = await payload.find({
    collection: 'roles' as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { slug: { equals: SUPER_ADMIN_SLUG } },
  })
  const email = `scope-super-${fixture.stamp}@example.com`
  const user = await payload.create({
    collection: 'users',
    data: { email, password: 'test-password-123', roles: [role.docs[0].id] },
    overrideAccess: true,
    context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
  })
  extraUserIds.push(Number(user.id))
  return { id: Number(user.id), email, password: 'test-password-123' }
}

async function permissionId(key: string): Promise<number> {
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
