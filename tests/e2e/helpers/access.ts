import { randomBytes } from 'node:crypto'

import type { APIRequestContext } from '@playwright/test'

import { api } from './api'
import { withDatabase } from './database'
import { adminToken, attemptSignIn, createUser, uniqueEmail, uniqueIp } from './sign-in'

/** The only client security owner in the E2E database. */
const ownerCredentials = { email: 'e2e-owner@example.com', password: 'e2e-owner-password-123' }

/** A slug no other test or retry uses (`roles.slug` and the scope slugs are unique). */
export function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`
}

let cachedPermissionIds: Promise<Map<string, number>> | undefined

async function listPermissionIds(request: APIRequestContext): Promise<Map<string, number>> {
  const { status, body } = await api(request, {
    method: 'GET',
    path: '/api/permissions?limit=500&depth=0',
    token: adminToken(),
  })
  if (status !== 200) throw new Error(`Listing permissions answered ${status}`)
  return new Map((body.docs as { key: string; id: number }[]).map((doc) => [doc.key, doc.id]))
}

/** Permission ids by key, listed once per worker. Ids differ per database, so they are looked up, never hard-coded. */
export function permissionIds(request: APIRequestContext): Promise<Map<string, number>> {
  if (!cachedPermissionIds) {
    cachedPermissionIds = listPermissionIds(request).catch((error: unknown) => {
      cachedPermissionIds = undefined
      throw error
    })
  }
  return cachedPermissionIds
}

/** `POST /api/rbac/grants`. Returns the status. */
export async function setGrant(
  request: APIRequestContext,
  { roleId, key, granted }: { roleId: number; key: string; granted: boolean },
): Promise<number> {
  const permissionId = (await permissionIds(request)).get(key)
  if (permissionId === undefined) throw new Error(`No permission with key ${key}`)
  const { status } = await api(request, {
    method: 'POST',
    path: '/api/rbac/grants',
    token: adminToken(),
    data: { roleId, permissionId, granted },
  })
  return status
}

/** Creates a role as the admin and grants each key. Throws unless every grant answers 200. */
export async function createRole(
  request: APIRequestContext,
  { name, keys }: { name: string; keys: string[] },
): Promise<number> {
  const created = await api(request, {
    method: 'POST',
    path: '/api/roles',
    token: adminToken(),
    data: { name, slug: uniqueSlug('role') },
  })
  if (created.status !== 201) {
    throw new Error(`Creating role ${name} answered ${created.status}: ${created.message}`)
  }
  const roleId = created.body.doc.id as number
  const ids = await permissionIds(request)
  for (const key of keys) {
    const permissionId = ids.get(key)
    if (permissionId === undefined) throw new Error(`No permission with key ${key}`)
    const grant = await api(request, {
      method: 'POST',
      path: '/api/rbac/grants',
      token: adminToken(),
      data: { roleId, permissionId, granted: true },
    })
    if (grant.status !== 200) {
      throw new Error(`Granting ${key} answered ${grant.status}: ${grant.message}`)
    }
  }
  return roleId
}

export async function superAdminRoleId(request: APIRequestContext): Promise<number> {
  const { body } = await api(request, {
    method: 'GET',
    path: '/api/roles?where[slug][equals]=super-admin&depth=0',
    token: adminToken(),
  })
  return body.docs[0].id as number
}

/** One sign-in over the API from a fresh address. Throws unless it answers 200. */
export async function signInToken(
  request: APIRequestContext,
  user: { email: string; password: string },
): Promise<string> {
  const result = await attemptSignIn(request, { ...user, ip: uniqueIp() })
  if (result.status !== 200 || !result.token) {
    throw new Error(`Signing in ${user.email} answered ${result.status}: ${result.message}`)
  }
  return result.token
}

/**
 * The shared client security owner. No API makes a first owner (operators use
 * `scripts/bootstrap-client-security-owner.mjs`), so it is created as a Super Admin and promoted in
 * D1. It must stay the only owner: the "final owner cannot be demoted" case depends on it.
 */
export async function ensureOwner(
  request: APIRequestContext,
): Promise<{ id: number; email: string; password: string }> {
  const found = await api(request, {
    method: 'GET',
    path: `/api/users?where[email][equals]=${encodeURIComponent(ownerCredentials.email)}&depth=0`,
    token: adminToken(),
  })
  let id: number | undefined = found.body?.docs?.[0]?.id
  if (id === undefined) {
    id = await createUser(request, {
      ...ownerCredentials,
      roles: [await superAdminRoleId(request)],
    })
  }
  const owners = await withDatabase(false, (db) => {
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(id)
    return db.prepare("SELECT email FROM users WHERE role = 'owner'").all() as { email: string }[]
  })
  if (owners.length !== 1 || owners[0].email !== ownerCredentials.email) {
    throw new Error(
      `Expected ${ownerCredentials.email} to be the only owner, found ${JSON.stringify(owners)}`,
    )
  }
  return { id, ...ownerCredentials }
}

const USER_PASSWORD = 'e2e-role-user-password-123'

/** A role with the given keys and a user holding it, signed in over the API. */
export async function userWithRole(
  request: APIRequestContext,
  keys: string[],
): Promise<{
  email: string
  password: string
  id: number
  roleId: number
  roleName: string
  token: string
}> {
  const roleName = `Role ${uniqueSlug('r')}`
  const roleId = await createRole(request, { name: roleName, keys })
  const email = uniqueEmail('rbac')
  const id = await createUser(request, { email, password: USER_PASSWORD, roles: [roleId] })
  const token = await signInToken(request, { email, password: USER_PASSWORD })
  return { email, password: USER_PASSWORD, id, roleId, roleName, token }
}
