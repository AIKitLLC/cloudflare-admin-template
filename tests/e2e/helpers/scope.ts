import { randomBytes } from 'node:crypto'

import type { APIRequestContext } from '@playwright/test'

import { createRole, permissionIds, uniqueSlug } from './access'
import { api } from './api'
import { adminToken, createUser, uniqueEmail } from './sign-in'

export type ScopeTree = {
  /** Random text in every title, so an admin list can be filtered to this test's rows. */
  token: string
  orgA: number
  orgA1: number
  orgB: number
  brA: number
  brA1: number
  brB: number
  classPublic: number
  classSecret: number
  titles: { aPublic: string; aSecret: string; a1Public: string; bPublic: string }
  records: { aPublic: number; aSecret: number; a1Public: number; bPublic: number }
}

async function create(
  request: APIRequestContext,
  collection: string,
  data: unknown,
): Promise<number> {
  const result = await api(request, {
    method: 'POST',
    path: `/api/${collection}`,
    token: adminToken(),
    data,
  })
  if (result.status !== 201) {
    throw new Error(`Creating in ${collection} answered ${result.status}: ${result.message}`)
  }
  return result.body.doc.id as number
}

/**
 * Organizations A (with child A1) and B, a branch in each, two data classes and four records:
 * A/Public, A/Secret, A1/Public, B/Public. Every slug and title is unique to the call.
 */
export async function createScopeTree(request: APIRequestContext): Promise<ScopeTree> {
  const token = randomBytes(4).toString('hex')
  const orgA = await create(request, 'organizations', {
    name: `Org A ${token}`,
    slug: uniqueSlug('org-a'),
  })
  const orgA1 = await create(request, 'organizations', {
    name: `Org A1 ${token}`,
    slug: uniqueSlug('org-a1'),
    parent: orgA,
  })
  const orgB = await create(request, 'organizations', {
    name: `Org B ${token}`,
    slug: uniqueSlug('org-b'),
  })
  const brA = await create(request, 'branches', {
    name: `Branch A ${token}`,
    slug: uniqueSlug('br-a'),
    organization: orgA,
  })
  const brA1 = await create(request, 'branches', {
    name: `Branch A1 ${token}`,
    slug: uniqueSlug('br-a1'),
    organization: orgA1,
  })
  const brB = await create(request, 'branches', {
    name: `Branch B ${token}`,
    slug: uniqueSlug('br-b'),
    organization: orgB,
  })
  const classPublic = await create(request, 'data-classes', {
    name: `Public ${token}`,
    slug: uniqueSlug('public'),
  })
  const classSecret = await create(request, 'data-classes', {
    name: `Secret ${token}`,
    slug: uniqueSlug('secret'),
  })
  const titles = {
    aPublic: `${token} A public`,
    aSecret: `${token} A secret`,
    a1Public: `${token} A1 public`,
    bPublic: `${token} B public`,
  }
  const record = (title: string, organization: number, branch: number, dataClass: number) =>
    create(request, 'records', { title, organization, branch, dataClass })
  return {
    token,
    orgA,
    orgA1,
    orgB,
    brA,
    brA1,
    brB,
    classPublic,
    classSecret,
    titles,
    records: {
      aPublic: await record(titles.aPublic, orgA, brA, classPublic),
      aSecret: await record(titles.aSecret, orgA, brA, classSecret),
      a1Public: await record(titles.a1Public, orgA1, brA1, classPublic),
      bPublic: await record(titles.bPublic, orgB, brB, classPublic),
    },
  }
}

/**
 * A role that reads and writes `records` and reads the three scope collections. A scoped role also
 * needs the field-read keys: without them `sort=title` is a 400 and documents come back empty.
 */
export async function scopedReaderRole(
  request: APIRequestContext,
  extraKeys: string[] = [],
): Promise<number> {
  const keys = [...(await permissionIds(request)).keys()].filter((key) => {
    const [collection, action] = key.split(':')
    if (collection === 'records') {
      return ['read', 'create', 'update', 'delete', 'readField', 'writeField'].includes(action)
    }
    return (
      ['organizations', 'branches', 'data-classes'].includes(collection) &&
      ['read', 'readField'].includes(action)
    )
  })
  return createRole(request, {
    name: `Scoped reader ${uniqueSlug('r')}`,
    keys: [...keys, ...extraKeys],
  })
}

/** A user with the role and the given scope, created by the admin. */
export async function scopedUser(
  request: APIRequestContext,
  args: {
    /** Left out for a user with no role: the one kind of account a limited manager may edit, since a role's keys must be a subset of the manager's. */
    roleId?: number
    organizations?: number[]
    branches?: number[]
    dataClasses?: number[]
  },
): Promise<{ id: number; email: string; password: string }> {
  const email = uniqueEmail('scoped')
  const password = 'e2e-scoped-user-password-123'
  const id = await createUser(request, {
    email,
    password,
    roles: args.roleId === undefined ? undefined : [args.roleId],
    organizations: args.organizations,
    branches: args.branches,
    dataClasses: args.dataClasses,
  })
  return { id, email, password }
}

/** Record titles as a user sees them, sorted. Pass `filterToken` to narrow an unscoped reader. */
export async function recordTitles(
  request: APIRequestContext,
  token: string,
  filterToken?: string,
): Promise<string[]> {
  const where = filterToken ? `&where[title][like]=${filterToken}` : ''
  const result = await api(request, {
    method: 'GET',
    path: `/api/records?limit=100&sort=title&depth=0${where}`,
    token,
  })
  if (result.status !== 200)
    throw new Error(`Listing records answered ${result.status}: ${result.message}`)
  return (result.body.docs as { title: string }[]).map((doc) => doc.title)
}

/** Names in a scope collection as a user sees them (organizations, branches, data-classes). */
export async function scopeNames(
  request: APIRequestContext,
  token: string,
  collection: string,
): Promise<string[]> {
  const result = await api(request, {
    method: 'GET',
    path: `/api/${collection}?limit=100&sort=name&depth=0`,
    token,
  })
  if (result.status !== 200) throw new Error(`Listing ${collection} answered ${result.status}`)
  return (result.body.docs as { name: string }[]).map((doc) => doc.name)
}
