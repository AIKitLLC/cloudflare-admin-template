// @vitest-environment node
import { sql } from '@payloadcms/db-d1-sqlite'
import { createLocalReq, type CollectionSlug, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { exportCollection } from '@/access/export/create-export-endpoint'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/rbac/guards/privilege-context'
import { SUPER_ADMIN_SLUG } from '@/access/constants'
import { relationIds } from '@/access/relation-id'
import {
  SCOPE_ASSIGNMENT_ERROR,
  SCOPE_ASSIGNMENT_LIMIT_ERROR,
  SCOPE_ASSIGNMENT_READ_ERROR,
  SCOPE_CYCLE_ERROR,
  SCOPE_GRANT_ERROR,
  SCOPE_NODE_ERROR,
  SCOPE_NODE_IN_USE_ERROR,
  SCOPE_RECORD_ERROR,
  SCOPE_REPARENT_KEYS_ERROR,
  SCOPE_ROLE_TARGET_ERROR,
  SCOPE_TARGET_KEYS_ERROR,
  SELF_SCOPE_ASSIGNMENT_ERROR,
} from '@/scope/errors'
import { loadEffectiveScope } from '@/scope/resolve/load-effective-scope'
import {
  BRANCHES_SLUG,
  DATA_CLASSES_SLUG,
  MAX_DIRECT_ASSIGNMENTS,
  ORGANIZATIONS_SLUG,
  RECORDS_SLUG,
} from '@/scope/constants'
import {
  WORK_NOTE_BRANCH_FIELD,
  WORK_NOTE_DATA_CLASS_FIELD,
  WORK_NOTE_ORGANIZATION_FIELD,
  WORK_NOTES_SLUG,
} from '../helpers/WorkNotes'
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
    const child = await payload.findByID({
      collection: ORGANIZATIONS_SLUG as CollectionSlug,
      id: fixture.westChildId,
      overrideAccess: false,
      user: asUser(fixture.branchUser),
    })
    expect(Number(child.id)).toBe(fixture.westChildId)
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
    expect(visibleIds).not.toContain(fixture.emptyUser.id)
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
        role: 'admin',
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

  it('refuses to re-parent a node onto a user the actor cannot cover', async () => {
    const parent = await payload.create({
      collection: ORGANIZATIONS_SLUG as CollectionSlug,
      data: {
        name: `Reparent parent ${fixture.stamp}`,
        slug: `reparent-parent-${fixture.stamp}`,
        parent: fixture.westId,
      },
      overrideAccess: true,
    })
    const node = await payload.create({
      collection: ORGANIZATIONS_SLUG as CollectionSlug,
      data: {
        name: `Reparent node ${fixture.stamp}`,
        slug: `reparent-node-${fixture.stamp}`,
        parent: fixture.westId,
      },
      overrideAccess: true,
    })
    const role = await payload.create({
      collection: 'roles' as CollectionSlug,
      data: {
        name: `Reparent ${fixture.stamp}`,
        slug: `reparent-${fixture.stamp}`,
        grantsFullAccess: false,
      },
      overrideAccess: true,
    })
    await grantKey(payload, Number(role.id), 'media:read')
    const holder = await payload.create({
      collection: 'users',
      data: {
        role: 'admin',
        email: `reparent-holder-${fixture.stamp}@example.com`,
        password: 'test-password-123',
        roles: [role.id],
        organizations: [parent.id],
      },
      overrideAccess: true,
      context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
    })
    try {
      await expect(
        payload.update({
          collection: ORGANIZATIONS_SLUG as CollectionSlug,
          id: node.id,
          data: { parent: parent.id },
          overrideAccess: false,
          user: asUser(fixture.actor),
        }),
      ).rejects.toThrow(SCOPE_REPARENT_KEYS_ERROR)

      const covered = await payload.create({
        collection: 'roles' as CollectionSlug,
        data: {
          name: `Reparent covered ${fixture.stamp}`,
          slug: `reparent-covered-${fixture.stamp}`,
          grantsFullAccess: false,
        },
        overrideAccess: true,
      })
      await grantKey(payload, Number(covered.id), 'records:read')
      await payload.update({
        collection: 'users',
        id: holder.id,
        data: { roles: [covered.id] },
        overrideAccess: true,
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
      await payload.update({
        collection: ORGANIZATIONS_SLUG as CollectionSlug,
        id: node.id,
        data: { parent: parent.id },
        overrideAccess: false,
        user: asUser(fixture.actor),
      })
      const moved = await payload.findByID({
        collection: ORGANIZATIONS_SLUG,
        id: node.id,
        depth: 0,
        overrideAccess: true,
      })
      expect(Number(moved.parent)).toBe(Number(parent.id))
      await payload.delete({
        collection: 'role-permissions' as CollectionSlug,
        where: { role: { equals: covered.id } },
        overrideAccess: true,
      })
      await payload.delete({
        collection: 'roles' as CollectionSlug,
        id: covered.id,
        overrideAccess: true,
      })
    } finally {
      await payload.delete({
        collection: 'users',
        id: holder.id,
        overrideAccess: true,
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
      await payload.delete({
        collection: ORGANIZATIONS_SLUG as CollectionSlug,
        id: node.id,
        overrideAccess: true,
      })
      await payload.delete({
        collection: ORGANIZATIONS_SLUG as CollectionSlug,
        id: parent.id,
        overrideAccess: true,
      })
      await payload.delete({
        collection: 'role-permissions' as CollectionSlug,
        where: { role: { equals: role.id } },
        overrideAccess: true,
      })
      await payload.delete({
        collection: 'roles' as CollectionSlug,
        id: role.id,
        overrideAccess: true,
      })
    }
  })

  it('lists, counts, reads, and exports more than 100 in-scope nodes and users', async () => {
    const orgIds: number[] = []
    const userIds: number[] = []
    const recordIds: number[] = []
    let deepBranchId: number | undefined
    try {
      for (let index = 0; index < 101; index += 1) {
        const org = await payload.create({
          collection: ORGANIZATIONS_SLUG as CollectionSlug,
          data: {
            name: `Wide ${fixture.stamp} ${index}`,
            slug: `wide-${fixture.stamp}-${index}`,
            parent: fixture.westId,
          },
          overrideAccess: true,
        })
        orgIds.push(Number(org.id))
        const record = await payload.create({
          collection: RECORDS_SLUG as CollectionSlug,
          data: {
            title: `Wide record ${fixture.stamp} ${index}`,
            organization: fixture.westId,
            branch: fixture.westMainBranchId,
            dataClass: fixture.piiId,
          },
          overrideAccess: true,
        })
        recordIds.push(Number(record.id))
        const user = await payload.create({
          collection: 'users',
          data: {
            role: 'admin',
            email: `wide-${fixture.stamp}-${index}@example.com`,
            password: 'test-password-123',
            roles: [fixture.insideRoleId],
            organizations: [fixture.westId],
            dataClasses: [fixture.sensitiveId],
          },
          overrideAccess: true,
          context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
        })
        userIds.push(Number(user.id))
      }
      const deepBranch = await payload.create({
        collection: BRANCHES_SLUG as CollectionSlug,
        data: {
          name: `Deep ${fixture.stamp}`,
          slug: `deep-${fixture.stamp}`,
          organization: orgIds[100],
        },
        overrideAccess: true,
      })
      deepBranchId = Number(deepBranch.id)
      const deepRecord = await payload.create({
        collection: RECORDS_SLUG as CollectionSlug,
        data: {
          title: `Deep record ${fixture.stamp}`,
          organization: orgIds[100],
          branch: deepBranch.id,
          dataClass: fixture.piiId,
        },
        overrideAccess: true,
      })
      recordIds.push(Number(deepRecord.id))

      const actor = asUser(fixture.actor)
      const orgs = await payload.find({
        collection: ORGANIZATIONS_SLUG as CollectionSlug,
        depth: 0,
        limit: 10,
        overrideAccess: false,
        user: actor,
      })
      expect(orgs.totalDocs).toBeGreaterThan(100)
      const orgCount = await payload.count({
        collection: ORGANIZATIONS_SLUG as CollectionSlug,
        overrideAccess: false,
        user: actor,
      })
      expect(orgCount.totalDocs).toBe(orgs.totalDocs)

      const records = await payload.count({
        collection: RECORDS_SLUG as CollectionSlug,
        overrideAccess: false,
        user: actor,
      })
      expect(records.totalDocs).toBeGreaterThan(100)
      const deep = await payload.findByID({
        collection: RECORDS_SLUG,
        id: deepRecord.id,
        overrideAccess: false,
        user: actor,
      })
      expect(deep.title).toContain('Deep record')

      const users = await payload.find({
        collection: 'users',
        depth: 0,
        limit: 10,
        overrideAccess: false,
        user: actor,
      })
      expect(users.totalDocs).toBeGreaterThan(100)
      expect(users.docs.some((doc) => doc.id === fixture.emptyUser.id)).toBe(false)

      const exported = await exportCollection(
        await createLocalReq({ user: actor }, payload),
        ORGANIZATIONS_SLUG,
      )
      expect(exported.status).toBe(200)
      expect(await exported.text()).toContain(`wide-${fixture.stamp}-100`)
      const userExport = await exportCollection(
        await createLocalReq({ user: actor }, payload),
        'users',
      )
      expect(userExport.status).toBe(200)
      expect(await userExport.text()).toContain(`wide-${fixture.stamp}-0@example.com`)
    } finally {
      await deleteInChunks(RECORDS_SLUG, recordIds)
      await deleteInChunks('users', userIds, { [SKIP_RBAC_PRIVILEGE_CHECKS]: true })
      if (deepBranchId !== undefined) {
        await payload.delete({
          collection: BRANCHES_SLUG as CollectionSlug,
          id: deepBranchId,
          overrideAccess: true,
        })
      }
      await deleteInChunks(ORGANIZATIONS_SLUG, orgIds)
    }
  }, 180000)

  it('moves a subtree so the old ancestor loses it and the new ancestor gains it', async () => {
    const oldParent = await payload.create({
      collection: ORGANIZATIONS_SLUG,
      data: {
        name: `Old ancestor ${fixture.stamp}`,
        slug: `old-ancestor-${fixture.stamp}`,
        parent: fixture.westId,
      },
      overrideAccess: true,
    })
    const node = await payload.create({
      collection: ORGANIZATIONS_SLUG,
      data: {
        name: `Moved node ${fixture.stamp}`,
        slug: `moved-node-${fixture.stamp}`,
        parent: oldParent.id,
      },
      overrideAccess: true,
    })
    const child = await payload.create({
      collection: ORGANIZATIONS_SLUG,
      data: {
        name: `Moved child ${fixture.stamp}`,
        slug: `moved-child-${fixture.stamp}`,
        parent: node.id,
      },
      overrideAccess: true,
    })
    const grandchild = await payload.create({
      collection: ORGANIZATIONS_SLUG,
      data: {
        name: `Moved grandchild ${fixture.stamp}`,
        slug: `moved-grandchild-${fixture.stamp}`,
        parent: child.id,
      },
      overrideAccess: true,
    })
    const newParent = await payload.create({
      collection: ORGANIZATIONS_SLUG,
      data: {
        name: `New ancestor ${fixture.stamp}`,
        slug: `new-ancestor-${fixture.stamp}`,
        parent: fixture.westId,
      },
      overrideAccess: true,
    })
    const branch = await payload.create({
      collection: BRANCHES_SLUG,
      data: {
        name: `Moved branch ${fixture.stamp}`,
        slug: `moved-branch-${fixture.stamp}`,
        organization: grandchild.id,
      },
      overrideAccess: true,
    })
    const record = await payload.create({
      collection: RECORDS_SLUG,
      data: {
        title: `Moved record ${fixture.stamp}`,
        organization: grandchild.id,
        branch: branch.id,
        dataClass: fixture.piiId,
      },
      overrideAccess: true,
    })
    const oldUser = await payload.create({
      collection: 'users',
      data: {
        role: 'admin',
        email: `old-ancestor-${fixture.stamp}@example.com`,
        password: 'test-password-123',
        roles: [fixture.actorRoleId],
        organizations: [oldParent.id],
        dataClasses: [fixture.sensitiveId],
      },
      overrideAccess: true,
      context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
    })
    const newUser = await payload.create({
      collection: 'users',
      data: {
        role: 'admin',
        email: `new-ancestor-${fixture.stamp}@example.com`,
        password: 'test-password-123',
        roles: [fixture.actorRoleId],
        organizations: [newParent.id],
        dataClasses: [fixture.sensitiveId],
      },
      overrideAccess: true,
      context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
    })
    const orgIds = [grandchild.id, child.id, node.id, oldParent.id, newParent.id]
    try {
      expect(await visibleCount(ORGANIZATIONS_SLUG, oldUser.id, grandchild.id)).toBe(1)
      expect(await visibleCount(RECORDS_SLUG, oldUser.id, record.id)).toBe(1)
      expect(await visibleCount(ORGANIZATIONS_SLUG, newUser.id, grandchild.id)).toBe(0)

      await payload.update({
        collection: ORGANIZATIONS_SLUG,
        id: node.id,
        data: { parent: newParent.id },
        overrideAccess: true,
      })

      const stored = await payload.findByID({
        collection: ORGANIZATIONS_SLUG,
        id: grandchild.id,
        depth: 0,
        overrideAccess: true,
      })
      expect(stored.scopePath).toContain(`/${newParent.id}/`)
      expect(stored.scopePath).toContain(`/${node.id}/`)
      expect(stored.scopePath).not.toContain(`/${oldParent.id}/`)
      expect(await visibleCount(ORGANIZATIONS_SLUG, oldUser.id, grandchild.id)).toBe(0)
      expect(await visibleCount(RECORDS_SLUG, oldUser.id, record.id)).toBe(0)
      expect(await visibleCount(ORGANIZATIONS_SLUG, newUser.id, grandchild.id)).toBe(1)
      expect(await visibleCount(RECORDS_SLUG, newUser.id, record.id)).toBe(1)
    } finally {
      await payload.delete({
        collection: RECORDS_SLUG,
        id: record.id,
        overrideAccess: true,
      })
      await payload.delete({
        collection: BRANCHES_SLUG,
        id: branch.id,
        overrideAccess: true,
      })
      await deleteInChunks('users', [oldUser.id, newUser.id], {
        [SKIP_RBAC_PRIVILEGE_CHECKS]: true,
      })
      for (const id of orgIds) {
        await payload.delete({
          collection: ORGANIZATIONS_SLUG,
          id,
          overrideAccess: true,
        })
      }
    }
  })

  it('keeps an ancestor assignment and refuses a combined assignment list past the cap', async () => {
    const admin = await existingSuperAdmin()
    const target = await payload.create({
      collection: 'users',
      data: {
        role: 'admin',
        email: `cap-${fixture.stamp}@example.com`,
        password: 'test-password-123',
        roles: [fixture.insideRoleId],
        organizations: [fixture.westId],
      },
      overrideAccess: true,
      context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
    })
    extraUserIds.push(Number(target.id))
    await payload.update({
      collection: 'users',
      id: target.id,
      data: { organizations: [fixture.westChildId, fixture.westId] },
      overrideAccess: false,
      user: asUser(admin),
    })
    const stored = await payload.findByID({
      collection: 'users',
      id: target.id,
      depth: 0,
      overrideAccess: true,
    })
    expect(relationIds(stored.organizations)).toEqual([String(fixture.westId)])

    const orgIds: number[] = []
    const branchIds: number[] = []
    try {
      for (let index = 0; index < MAX_DIRECT_ASSIGNMENTS + 1; index += 1) {
        const org = await payload.create({
          collection: ORGANIZATIONS_SLUG,
          data: {
            name: `Cap ${fixture.stamp} ${index}`,
            slug: `cap-${fixture.stamp}-${index}`,
          },
          overrideAccess: true,
        })
        orgIds.push(Number(org.id))
      }
      await expect(
        payload.update({
          collection: 'users',
          id: target.id,
          data: { organizations: orgIds },
          overrideAccess: false,
          user: asUser(admin),
        }),
      ).rejects.toThrow(SCOPE_ASSIGNMENT_LIMIT_ERROR)
      const unchanged = await payload.findByID({
        collection: 'users',
        id: target.id,
        depth: 0,
        overrideAccess: true,
      })
      expect(relationIds(unchanged.organizations)).toEqual([String(fixture.westId)])

      const organizationCount = 10
      const branchCount = MAX_DIRECT_ASSIGNMENTS - organizationCount
      const kept = orgIds.slice(0, organizationCount)
      await payload.update({
        collection: 'users',
        id: target.id,
        data: { organizations: kept },
        overrideAccess: false,
        user: asUser(admin),
      })
      for (let index = 0; index < branchCount + 1; index += 1) {
        const branch = await payload.create({
          collection: BRANCHES_SLUG,
          data: {
            name: `Cap branch ${fixture.stamp} ${index}`,
            slug: `cap-branch-${fixture.stamp}-${index}`,
            organization: kept[0],
          },
          overrideAccess: true,
        })
        branchIds.push(Number(branch.id))
      }
      await payload.update({
        collection: 'users',
        id: target.id,
        data: { branches: branchIds.slice(0, branchCount) },
        overrideAccess: false,
        user: asUser(admin),
      })
      const atCap = await payload.findByID({
        collection: 'users',
        id: target.id,
        depth: 0,
        overrideAccess: true,
      })
      expect(relationIds(atCap.organizations)).toEqual(kept.map(String))
      expect(relationIds(atCap.branches)).toEqual(branchIds.slice(0, branchCount).map(String))
      await expect(
        payload.update({
          collection: 'users',
          id: target.id,
          data: { branches: branchIds },
          overrideAccess: false,
          user: asUser(admin),
        }),
      ).rejects.toThrow(SCOPE_ASSIGNMENT_LIMIT_ERROR)
      const still = await payload.findByID({
        collection: 'users',
        id: target.id,
        depth: 0,
        overrideAccess: true,
      })
      expect(relationIds(still.organizations)).toEqual(kept.map(String))
      expect(relationIds(still.branches)).toEqual(branchIds.slice(0, branchCount).map(String))
    } finally {
      await deleteInChunks(BRANCHES_SLUG, branchIds)
      await deleteInChunks(ORGANIZATIONS_SLUG, orgIds)
    }
  }, 120000)

  it('refuses reads when stored assignments already exceed the cap', async () => {
    const orgIds: number[] = []
    const logged: unknown[] = []
    const error = vi.spyOn(payload.logger, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
    try {
      for (let index = 0; index < MAX_DIRECT_ASSIGNMENTS + 1; index += 1) {
        const org = await payload.create({
          collection: ORGANIZATIONS_SLUG,
          data: {
            name: `Over cap ${fixture.stamp} ${index}`,
            slug: `over-cap-${fixture.stamp}-${index}`,
          },
          overrideAccess: true,
        })
        orgIds.push(Number(org.id))
      }
      const reader = await payload.create({
        collection: 'users',
        data: {
          role: 'admin',
          email: `over-cap-${fixture.stamp}@example.com`,
          password: 'test-password-123',
          roles: [fixture.actorRoleId],
          organizations: orgIds,
        },
        overrideAccess: true,
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
      extraUserIds.push(Number(reader.id))
      const account = {
        id: Number(reader.id),
        email: `over-cap-${fixture.stamp}@example.com`,
        password: 'test-password-123',
      }
      await expect(findRecords(account)).rejects.toThrow(SCOPE_ASSIGNMENT_READ_ERROR)
      await expect(
        payload.find({
          collection: 'users',
          depth: 0,
          limit: 1,
          overrideAccess: false,
          user: asUser(account),
        }),
      ).rejects.toThrow(SCOPE_ASSIGNMENT_READ_ERROR)
      expect(JSON.stringify(logged)).toContain(SCOPE_ASSIGNMENT_READ_ERROR)
      expect(JSON.stringify(logged)).not.toContain('Expression tree is too large')
    } finally {
      error.mockRestore()
      await deleteInChunks(ORGANIZATIONS_SLUG, orgIds)
    }
  }, 120000)

  it('rebuilds a subtree when the moved node has no stored path', async () => {
    const oldParent = await payload.create({
      collection: ORGANIZATIONS_SLUG,
      data: {
        name: `Null path old ${fixture.stamp}`,
        slug: `null-path-old-${fixture.stamp}`,
        parent: fixture.westId,
      },
      overrideAccess: true,
    })
    const node = await payload.create({
      collection: ORGANIZATIONS_SLUG,
      data: {
        name: `Null path node ${fixture.stamp}`,
        slug: `null-path-node-${fixture.stamp}`,
        parent: oldParent.id,
      },
      overrideAccess: true,
    })
    const grandchild = await payload.create({
      collection: ORGANIZATIONS_SLUG,
      data: {
        name: `Null path grandchild ${fixture.stamp}`,
        slug: `null-path-grandchild-${fixture.stamp}`,
        parent: node.id,
      },
      overrideAccess: true,
    })
    const newParent = await payload.create({
      collection: ORGANIZATIONS_SLUG,
      data: {
        name: `Null path new ${fixture.stamp}`,
        slug: `null-path-new-${fixture.stamp}`,
        parent: fixture.westId,
      },
      overrideAccess: true,
    })
    const drizzle = (payload.db as { drizzle: { run: (query: unknown) => Promise<unknown> } })
      .drizzle
    await drizzle.run(sql`UPDATE organizations SET scope_path = NULL WHERE id = ${node.id}`)
    try {
      await payload.update({
        collection: ORGANIZATIONS_SLUG,
        id: node.id,
        data: { parent: newParent.id },
        overrideAccess: true,
      })
      const stored = await payload.findByID({
        collection: ORGANIZATIONS_SLUG,
        id: grandchild.id,
        depth: 0,
        overrideAccess: true,
      })
      expect(stored.scopePath).toContain(`/${newParent.id}/`)
      expect(stored.scopePath).toContain(`/${node.id}/`)
      expect(stored.scopePath).not.toContain(`/${oldParent.id}/`)
    } finally {
      for (const id of [grandchild.id, node.id, oldParent.id, newParent.id]) {
        await payload.delete({
          collection: ORGANIZATIONS_SLUG,
          id,
          overrideAccess: true,
        })
      }
    }
  })

  it('filters a second scoped collection from its own relationship fields', async () => {
    const orgIds: number[] = []
    const branchIds: number[] = []
    const userIds: number[] = []
    const noteIds: number[] = []
    try {
      await grantKey(payload, fixture.actorRoleId, `${WORK_NOTES_SLUG}:read`)
      for (let index = 0; index < 2; index += 1) {
        const org = await payload.create({
          collection: ORGANIZATIONS_SLUG,
          data: {
            name: `Note org ${fixture.stamp} ${index}`,
            slug: `note-org-${fixture.stamp}-${index}`,
          },
          overrideAccess: true,
        })
        orgIds.push(Number(org.id))
        const branch = await payload.create({
          collection: BRANCHES_SLUG,
          data: {
            name: `Note branch ${fixture.stamp} ${index}`,
            slug: `note-branch-${fixture.stamp}-${index}`,
            organization: org.id,
          },
          overrideAccess: true,
        })
        branchIds.push(Number(branch.id))
      }
      const reader = await payload.create({
        collection: 'users',
        data: {
          role: 'admin',
          email: `notes-${fixture.stamp}@example.com`,
          password: 'test-password-123',
          roles: [fixture.actorRoleId],
          organizations: [orgIds[0]],
          dataClasses: [fixture.sensitiveId],
        },
        overrideAccess: true,
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
      userIds.push(Number(reader.id))
      const note = await payload.create({
        collection: WORK_NOTES_SLUG as CollectionSlug,
        data: {
          title: `Inside note ${fixture.stamp}`,
          [WORK_NOTE_ORGANIZATION_FIELD]: orgIds[0],
          [WORK_NOTE_BRANCH_FIELD]: branchIds[0],
          [WORK_NOTE_DATA_CLASS_FIELD]: fixture.piiId,
        } as never,
        overrideAccess: true,
      })
      noteIds.push(Number(note.id))
      const outside = await payload.create({
        collection: WORK_NOTES_SLUG as CollectionSlug,
        data: {
          title: `Outside note ${fixture.stamp}`,
          [WORK_NOTE_ORGANIZATION_FIELD]: orgIds[1],
          [WORK_NOTE_BRANCH_FIELD]: branchIds[1],
          [WORK_NOTE_DATA_CLASS_FIELD]: fixture.piiId,
        } as never,
        overrideAccess: true,
      })
      noteIds.push(Number(outside.id))

      expect(await visibleCount(WORK_NOTES_SLUG, reader.id, note.id)).toBe(1)
      expect(await visibleCount(WORK_NOTES_SLUG, reader.id, outside.id)).toBe(0)
      const listed = await payload.find({
        collection: WORK_NOTES_SLUG as CollectionSlug,
        depth: 0,
        limit: 10,
        overrideAccess: false,
        user: asUser({ id: Number(reader.id), email: reader.email, password: '' }),
      })
      expect(listed.docs.some((doc) => doc.id === note.id)).toBe(true)
      expect(listed.docs.some((doc) => doc.id === outside.id)).toBe(false)
    } finally {
      await deleteInChunks(WORK_NOTES_SLUG, noteIds)
      await deleteInChunks('users', userIds, { [SKIP_RBAC_PRIVILEGE_CHECKS]: true })
      await deleteInChunks(BRANCHES_SLUG, branchIds)
      await deleteInChunks(ORGANIZATIONS_SLUG, orgIds)
    }
  })
})

async function visibleCount(
  collection: string,
  userId: number | string,
  docId: number | string,
): Promise<number> {
  const result = await payload.count({
    collection: collection as CollectionSlug,
    overrideAccess: false,
    user: asUser({ id: Number(userId), email: '', password: '' }),
    where: { id: { equals: docId } },
  })
  return result.totalDocs
}

/**
 * Auth deletes also bind each id in the preferences user relationship, so a chunk of 80
 * plus the matching preference keys exceeds D1's 100 bound parameters.
 */
const DELETE_CHUNK = 40

async function deleteInChunks(
  collection: string,
  ids: Array<number | string>,
  context?: Record<string, unknown>,
) {
  for (let index = 0; index < ids.length; index += DELETE_CHUNK) {
    await payload.delete({
      collection: collection as CollectionSlug,
      where: { id: { in: ids.slice(index, index + DELETE_CHUNK) } },
      overrideAccess: true,
      context,
    })
  }
}

function asUser(user: ScopeUser) {
  return {
    id: user.id,
    email: user.email,
    role: 'admin' as const,
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

async function existingSuperAdmin(): Promise<ScopeUser> {
  const email = `scope-super-${fixture.stamp}@example.com`
  const existing = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { email: { equals: email } },
  })
  if (existing.docs[0]) {
    return { id: Number(existing.docs[0].id), email, password: 'test-password-123' }
  }
  return createSuperAdmin()
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
    data: { role: 'admin', email, password: 'test-password-123', roles: [role.docs[0].id] },
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
