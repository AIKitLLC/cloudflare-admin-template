import { getPayload, type CollectionSlug, type Payload } from 'payload'

import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/rbac/guards/privilege-context'
import { setRoleGrant } from '@/rbac/matrix/set-role-grant'
import {
  BRANCHES_SLUG,
  DATA_CLASSES_SLUG,
  ORGANIZATIONS_SLUG,
  RECORDS_SLUG,
} from '@/scope/constants'

const PASSWORD = 'test-password-123'

export type ScopeUser = {
  id: number
  email: string
  password: string
}

export type RowScopeFixture = {
  stamp: string
  westId: number
  westChildId: number
  eastId: number
  westMainBranchId: number
  westSubBranchId: number
  westChildBranchId: number
  eastBranchId: number
  sensitiveId: number
  piiId: number
  publicId: number
  westRecordId: number
  westSubRecordId: number
  westChildRecordId: number
  eastRecordId: number
  publicRecordId: number
  westTitle: string
  westSubTitle: string
  westChildTitle: string
  eastTitle: string
  publicTitle: string
  actor: ScopeUser
  eastUser: ScopeUser
  childUser: ScopeUser
  emptyUser: ScopeUser
  branchUser: ScopeUser
  actorRoleId: number
  insideRoleId: number
  outsideRoleId: number
  freshRoleId: number
  organizationIds: number[]
  branchIds: number[]
  dataClassIds: number[]
  recordIds: number[]
  userIds: number[]
  roleIds: number[]
}

export async function seedRowScopeFixture(
  payload: Payload,
  stamp: string,
): Promise<RowScopeFixture> {
  const westId = await createOrganization(payload, `West ${stamp}`, `west-${stamp}`)
  const eastId = await createOrganization(payload, `East ${stamp}`, `east-${stamp}`)
  const westChildId = await createOrganization(
    payload,
    `West child ${stamp}`,
    `west-child-${stamp}`,
    westId,
  )
  const westMainBranchId = await createBranch(
    payload,
    `West main ${stamp}`,
    `west-main-${stamp}`,
    westId,
  )
  const westSubBranchId = await createBranch(
    payload,
    `West sub ${stamp}`,
    `west-sub-${stamp}`,
    westId,
    westMainBranchId,
  )
  const westChildBranchId = await createBranch(
    payload,
    `West child branch ${stamp}`,
    `west-child-branch-${stamp}`,
    westChildId,
  )
  const eastBranchId = await createBranch(
    payload,
    `East main ${stamp}`,
    `east-main-${stamp}`,
    eastId,
  )
  const sensitiveId = await createDataClass(payload, `Sensitive ${stamp}`, `sensitive-${stamp}`)
  const piiId = await createDataClass(payload, `PII ${stamp}`, `pii-${stamp}`, sensitiveId)
  const publicId = await createDataClass(payload, `Public ${stamp}`, `public-${stamp}`)

  const westTitle = `West record ${stamp}`
  const westSubTitle = `West sub record ${stamp}`
  const westChildTitle = `West child record ${stamp}`
  const eastTitle = `East record ${stamp}`
  const publicTitle = `Public record ${stamp}`
  const westRecordId = await createRecord(payload, westTitle, westId, westMainBranchId, piiId)
  const westSubRecordId = await createRecord(payload, westSubTitle, westId, westSubBranchId, piiId)
  const westChildRecordId = await createRecord(
    payload,
    westChildTitle,
    westChildId,
    westChildBranchId,
    piiId,
  )
  const eastRecordId = await createRecord(payload, eastTitle, eastId, eastBranchId, piiId)
  const publicRecordId = await createRecord(
    payload,
    publicTitle,
    westId,
    westMainBranchId,
    publicId,
  )

  const actorRoleId = await createRole(payload, `scope-actor-${stamp}`)
  const insideRoleId = await createRole(payload, `scope-inside-${stamp}`)
  const outsideRoleId = await createRole(payload, `scope-outside-${stamp}`)
  const freshRoleId = await createRole(payload, `scope-fresh-${stamp}`)
  for (const slug of [
    'records',
    'organizations',
    'branches',
    'data-classes',
    'users',
    'roles',
    'role-permissions',
  ]) {
    await grantCollection(payload, actorRoleId, slug)
  }
  await grantKey(payload, insideRoleId, 'records:read')
  await grantKey(payload, freshRoleId, 'records:read')

  const actor = await createScopedUser(payload, `scope-actor-${stamp}@example.com`, [actorRoleId], {
    organizations: [westId],
    dataClasses: [sensitiveId],
  })
  const eastUser = await createScopedUser(
    payload,
    `scope-east-${stamp}@example.com`,
    [outsideRoleId],
    {
      organizations: [eastId],
      dataClasses: [sensitiveId],
    },
  )
  const childUser = await createScopedUser(
    payload,
    `scope-child-${stamp}@example.com`,
    [insideRoleId],
    {
      organizations: [westChildId],
      dataClasses: [piiId],
    },
  )
  const emptyUser = await createScopedUser(
    payload,
    `scope-empty-${stamp}@example.com`,
    [actorRoleId],
    {},
  )
  const branchUser = await createScopedUser(
    payload,
    `scope-branch-${stamp}@example.com`,
    [actorRoleId],
    {
      branches: [westSubBranchId],
      dataClasses: [piiId],
    },
  )

  return {
    stamp,
    westId,
    westChildId,
    eastId,
    westMainBranchId,
    westSubBranchId,
    westChildBranchId,
    eastBranchId,
    sensitiveId,
    piiId,
    publicId,
    westRecordId,
    westSubRecordId,
    westChildRecordId,
    eastRecordId,
    publicRecordId,
    westTitle,
    westSubTitle,
    westChildTitle,
    eastTitle,
    publicTitle,
    actor,
    eastUser,
    childUser,
    emptyUser,
    branchUser,
    actorRoleId,
    insideRoleId,
    outsideRoleId,
    freshRoleId,
    organizationIds: [westId, eastId, westChildId],
    branchIds: [westMainBranchId, westSubBranchId, westChildBranchId, eastBranchId],
    dataClassIds: [sensitiveId, piiId, publicId],
    recordIds: [westRecordId, westSubRecordId, westChildRecordId, eastRecordId, publicRecordId],
    userIds: [actor.id, eastUser.id, childUser.id, emptyUser.id, branchUser.id],
    roleIds: [actorRoleId, insideRoleId, outsideRoleId, freshRoleId],
  }
}

export async function cleanupRowScopeFixture(
  payload: Payload,
  fixture: RowScopeFixture,
): Promise<void> {
  const context = { [SKIP_RBAC_PRIVILEGE_CHECKS]: true }
  await payload.delete({
    collection: RECORDS_SLUG as CollectionSlug,
    where: { id: { in: fixture.recordIds } },
    overrideAccess: true,
    context,
  })
  await payload.delete({
    collection: 'users',
    where: { id: { in: fixture.userIds } },
    overrideAccess: true,
    context,
  })
  await payload.delete({
    collection: BRANCHES_SLUG as CollectionSlug,
    where: { id: { in: [fixture.westSubBranchId] } },
    overrideAccess: true,
    context,
  })
  await payload.delete({
    collection: BRANCHES_SLUG as CollectionSlug,
    where: {
      id: { in: [fixture.westMainBranchId, fixture.westChildBranchId, fixture.eastBranchId] },
    },
    overrideAccess: true,
    context,
  })
  await payload.delete({
    collection: DATA_CLASSES_SLUG as CollectionSlug,
    where: { id: { in: [fixture.piiId, fixture.publicId] } },
    overrideAccess: true,
    context,
  })
  await payload.delete({
    collection: DATA_CLASSES_SLUG as CollectionSlug,
    where: { id: { in: [fixture.sensitiveId] } },
    overrideAccess: true,
    context,
  })
  await payload.delete({
    collection: ORGANIZATIONS_SLUG as CollectionSlug,
    where: { id: { in: [fixture.westChildId] } },
    overrideAccess: true,
    context,
  })
  await payload.delete({
    collection: ORGANIZATIONS_SLUG as CollectionSlug,
    where: { id: { in: [fixture.westId, fixture.eastId] } },
    overrideAccess: true,
    context,
  })
  await payload.delete({
    collection: 'role-permissions' as CollectionSlug,
    where: { role: { in: fixture.roleIds } },
    overrideAccess: true,
    context,
  })
  await payload.delete({
    collection: 'roles' as CollectionSlug,
    where: { id: { in: fixture.roleIds } },
    overrideAccess: true,
    context,
  })
}

async function createOrganization(
  payload: Payload,
  name: string,
  slug: string,
  parent?: number,
): Promise<number> {
  const doc = await payload.create({
    collection: ORGANIZATIONS_SLUG as CollectionSlug,
    data: { name, slug, ...(parent ? { parent } : {}) },
    overrideAccess: true,
  })
  return Number(doc.id)
}

async function createBranch(
  payload: Payload,
  name: string,
  slug: string,
  organization: number,
  parent?: number,
): Promise<number> {
  const doc = await payload.create({
    collection: BRANCHES_SLUG as CollectionSlug,
    data: { name, slug, organization, ...(parent ? { parent } : {}) },
    overrideAccess: true,
  })
  return Number(doc.id)
}

async function createDataClass(
  payload: Payload,
  name: string,
  slug: string,
  parent?: number,
): Promise<number> {
  const doc = await payload.create({
    collection: DATA_CLASSES_SLUG as CollectionSlug,
    data: { name, slug, ...(parent ? { parent } : {}) },
    overrideAccess: true,
  })
  return Number(doc.id)
}

async function createRecord(
  payload: Payload,
  title: string,
  organization: number,
  branch: number,
  dataClass: number,
): Promise<number> {
  const doc = await payload.create({
    collection: RECORDS_SLUG as CollectionSlug,
    data: { title, organization, branch, dataClass },
    overrideAccess: true,
  })
  return Number(doc.id)
}

async function createRole(payload: Payload, slug: string): Promise<number> {
  const role = await payload.create({
    collection: 'roles' as CollectionSlug,
    data: { name: slug, slug, grantsFullAccess: false },
    overrideAccess: true,
  })
  return Number(role.id)
}

async function createScopedUser(
  payload: Payload,
  email: string,
  roles: number[],
  scope: { organizations?: number[]; branches?: number[]; dataClasses?: number[] },
): Promise<ScopeUser> {
  const user = await payload.create({
    collection: 'users',
    data: {
      role: 'admin',
      email,
      password: PASSWORD,
      roles,
      organizations: scope.organizations,
      branches: scope.branches,
      dataClasses: scope.dataClasses,
    },
    overrideAccess: true,
  })
  return { id: Number(user.id), email, password: PASSWORD }
}

async function grantCollection(payload: Payload, roleId: number, slug: string): Promise<void> {
  const permissions = await payload.find({
    collection: 'permissions' as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    where: { collectionSlug: { equals: slug } },
  })
  for (const permission of permissions.docs) {
    await setRoleGrant(payload, {
      roleId,
      permissionId: permission.id,
      granted: true,
    })
  }
}

export async function grantKey(payload: Payload, roleId: number, key: string): Promise<void> {
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

export async function openPayload(): Promise<Payload> {
  const { default: config } = await import('@/payload.config')
  return getPayload({ config })
}
