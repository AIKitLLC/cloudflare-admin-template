// @vitest-environment node
import { GRAPHQL_POST, REST_DELETE, REST_PATCH, REST_POST } from '@payloadcms/next/routes'
import { getPayload, type CollectionSlug, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import {
  PRIVILEGED_USER_ERROR,
  SUBSET_ASSIGNMENT_ERROR,
  SUBSET_GRANT_ERROR,
} from '@/rbac/guards/privilege-errors'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/rbac/guards/privilege-context'
import { setRoleGrant } from '@/rbac/matrix/set-role-grant'

const ORIGIN = 'http://localhost:3000'
const post = REST_POST(config)
const patch = REST_PATCH(config)
const remove = REST_DELETE(config)
const graphql = GRAPHQL_POST(config)

let payload: Payload
const stamp = Date.now()
const createdUserIds: Array<number | string> = []
const createdRoleIds: Array<number | string> = []

describe('RBAC HTTP privilege boundaries', () => {
  beforeAll(async () => {
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

  it('refuses the three-step escalation over REST and GraphQL, and rejects a foreign origin', async () => {
    const actorRole = await createRole(`http-actor-${stamp}`)
    for (const key of [
      'roles:create',
      'roles:writeField:name',
      'roles:writeField:slug',
      'role-permissions:create',
      'role-permissions:update',
      'role-permissions:read',
      'role-permissions:writeField:role',
      'role-permissions:writeField:permission',
      'role-permissions:writeField:granted',
      'users:read',
      'users:update',
      'users:writeField:roles',
      'media:read',
    ]) {
      await grant(actorRole.id, key)
    }
    const email = `rbac-http-${stamp}@example.com`
    const password = 'test-password-123'
    const user = await payload.create({
      collection: 'users',
      data: { email, password, roles: [actorRole.id] },
      overrideAccess: true,
      context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
    })
    createdUserIds.push(user.id)

    const login = await post(
      jsonRequest('/api/users/login', { email, password }),
      route(['users', 'login']),
    )
    expect(login.status).toBe(200)
    const cookie = cookieHeader(login)
    expect(cookie).toContain('payload-token=')

    const createdRole = await post(
      jsonRequest('/api/roles', { name: `Delegated ${stamp}`, slug: `delegated-${stamp}` }, cookie),
      route(['roles']),
    )
    expect(createdRole.status).toBeLessThan(300)
    const createdBody = (await createdRole.json()) as { doc?: { id?: number } }
    const delegatedId = Number(createdBody.doc?.id)
    expect(delegatedId).toBeGreaterThan(0)
    createdRoleIds.push(delegatedId)

    const usersDelete = await permissionIdFor('users:delete')
    const mediaRead = await permissionIdFor('media:read')

    const restGrant = await post(
      jsonRequest(
        '/api/role-permissions',
        { role: delegatedId, permission: usersDelete, granted: true },
        cookie,
      ),
      route(['role-permissions']),
    )
    expect(restGrant.status).toBe(403)
    expect(JSON.stringify(await restGrant.json())).toContain(SUBSET_GRANT_ERROR)

    const matrixGrant = await post(
      jsonRequest(
        '/api/rbac/grants',
        { roleId: delegatedId, permissionId: usersDelete, granted: true },
        cookie,
      ),
      route(['rbac', 'grants']),
    )
    expect(matrixGrant.status).toBe(403)
    expect(await matrixGrant.json()).toMatchObject({ error: SUBSET_GRANT_ERROR })

    const allowedGrant = await post(
      jsonRequest(
        '/api/rbac/grants',
        { roleId: delegatedId, permissionId: mediaRead, granted: true },
        cookie,
      ),
      route(['rbac', 'grants']),
    )
    expect(allowedGrant.status).toBe(200)

    const graphqlGrant = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `mutation Grant($role: Int!, $permission: Int!) {
            createRolePermission(data: { role: $role, permission: $permission, granted: true }) { id }
          }`,
          variables: { role: delegatedId, permission: usersDelete },
        },
        cookie,
      ),
    )
    const graphqlGrantBody = await graphqlGrant.json()
    expect(JSON.stringify(graphqlGrantBody)).toContain(SUBSET_GRANT_ERROR)

    const broader = await createRole(`http-broader-${stamp}`)
    await grant(broader.id, 'users:delete')
    const restAssign = await patch(
      jsonRequest(
        '/api/users/' + user.id,
        { roles: [actorRole.id, broader.id] },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(user.id)]),
    )
    expect(restAssign.status).toBe(403)
    expect(JSON.stringify(await restAssign.json())).toContain(SUBSET_ASSIGNMENT_ERROR)

    const graphqlAssign = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `mutation Assign($id: Int!, $roles: [Int!]) {
            updateUser(id: $id, data: { roles: $roles }) { id }
          }`,
          variables: { id: Number(user.id), roles: [actorRole.id, broader.id] },
        },
        cookie,
      ),
    )
    expect(JSON.stringify(await graphqlAssign.json())).toContain(SUBSET_ASSIGNMENT_ERROR)

    const selfAssign = await patch(
      jsonRequest(
        '/api/users/' + user.id,
        { roles: [actorRole.id, delegatedId] },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(user.id)]),
    )
    expect(selfAssign.status).toBeLessThan(300)

    const forged = await post(
      jsonRequest(
        '/api/rbac/grants',
        { roleId: delegatedId, permissionId: mediaRead, granted: true },
        cookie,
        'https://evil.example',
      ),
      route(['rbac', 'grants']),
    )
    expect(forged.status).toBe(401)
  })

  it('refuses taking over a more privileged account and still allows a lesser account', async () => {
    const actorRole = await createRole(`takeover-actor-${stamp}`)
    for (const key of ['users:read', 'users:update', 'users:delete', 'users:writeField:email']) {
      await grant(actorRole.id, key)
    }
    const lesserRole = await createRole(`takeover-lesser-${stamp}`)
    await grant(lesserRole.id, 'users:read')
    const broaderRole = await createRole(`takeover-broader-${stamp}`)
    await grant(broaderRole.id, 'users:read')
    await grant(broaderRole.id, 'media:read')
    const superAdmin = await findSuperAdminRole()
    const password = 'test-password-123'
    const actor = await createAccount(`takeover-actor-${stamp}@example.com`, password, [
      actorRole.id,
    ])
    const lesser = await createAccount(`takeover-lesser-${stamp}@example.com`, password, [
      lesserRole.id,
    ])
    const broader = await createAccount(`takeover-broader-${stamp}@example.com`, password, [
      broaderRole.id,
    ])
    const admin = await createAccount(`takeover-admin-${stamp}@example.com`, password, [
      superAdmin.id,
    ])
    const selfService = await createAccount(`takeover-self-${stamp}@example.com`, password, [
      lesserRole.id,
    ])

    const cookie = await loginCookie(actor.email, password)

    const passwordPatch = await patch(
      jsonRequest(
        `/api/users/${admin.id}`,
        { password: 'stolen-password-456' },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(admin.id)]),
    )
    expect(passwordPatch.status).toBe(403)
    expect(JSON.stringify(await passwordPatch.json())).toContain(PRIVILEGED_USER_ERROR)
    expect((await loginCookie(admin.email, password)).length).toBeGreaterThan(0)
    const stolen = await post(
      jsonRequest('/api/users/login', { email: admin.email, password: 'stolen-password-456' }),
      route(['users', 'login']),
    )
    expect(stolen.status).toBeGreaterThanOrEqual(400)

    const emailPatch = await patch(
      jsonRequest(
        `/api/users/${broader.id}`,
        { email: `taken-${stamp}@example.com` },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(broader.id)]),
    )
    expect(emailPatch.status).toBe(403)
    expect(JSON.stringify(await emailPatch.json())).toContain(PRIVILEGED_USER_ERROR)

    const graphqlPassword = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `mutation Take($id: Int!, $password: String) {
            updateUser(id: $id, data: { password: $password }) { id }
          }`,
          variables: { id: admin.id, password: 'stolen-password-456' },
        },
        cookie,
      ),
    )
    expect(JSON.stringify(await graphqlPassword.json())).toContain(PRIVILEGED_USER_ERROR)

    const deleted = await remove(
      jsonRequest(`/api/users/${broader.id}`, {}, cookie, ORIGIN, 'DELETE'),
      route(['users', String(broader.id)]),
    )
    expect(deleted.status).toBe(403)
    expect(JSON.stringify(await deleted.json())).toContain(PRIVILEGED_USER_ERROR)

    const lesserEmail = `edited-${stamp}@example.com`
    const edited = await patch(
      jsonRequest(`/api/users/${lesser.id}`, { email: lesserEmail }, cookie, ORIGIN, 'PATCH'),
      route(['users', String(lesser.id)]),
    )
    expect(edited.status).toBeLessThan(300)
    const freshLesser = await payload.findByID({
      collection: 'users',
      id: lesser.id,
      overrideAccess: true,
    })
    expect(freshLesser.email).toBe(lesserEmail)

    const forgotPrivileged = await post(
      jsonRequest('/api/users/forgot-password', { email: admin.email }, cookie),
      route(['users', 'forgot-password']),
    )
    expect(forgotPrivileged.status).toBe(403)
    expect(JSON.stringify(await forgotPrivileged.json())).toContain(PRIVILEGED_USER_ERROR)

    const publicAdminForgot = await post(
      jsonRequest('/api/users/forgot-password', { email: admin.email }),
      route(['users', 'forgot-password']),
    )
    expect(publicAdminForgot.status).toBeLessThan(300)
    const adminToken = await readResetToken(admin.email)
    expect(adminToken).toBeTruthy()
    const blockedReset = await post(
      jsonRequest(
        '/api/users/reset-password',
        { token: adminToken, password: 'stolen-password-456' },
        cookie,
      ),
      route(['users', 'reset-password']),
    )
    expect(blockedReset.status).toBe(403)
    expect(JSON.stringify(await blockedReset.json())).toContain(PRIVILEGED_USER_ERROR)
    expect((await loginCookie(admin.email, password)).length).toBeGreaterThan(0)

    const publicForgot = await post(
      jsonRequest('/api/users/forgot-password', { email: selfService.email }),
      route(['users', 'forgot-password']),
    )
    expect(publicForgot.status).toBeLessThan(300)
    const token = await readResetToken(selfService.email)
    expect(token).toBeTruthy()
    const reset = await post(
      jsonRequest('/api/users/reset-password', {
        token,
        password: 'self-service-password-456',
      }),
      route(['users', 'reset-password']),
    )
    expect(reset.status).toBeLessThan(300)
    expect(
      (await loginCookie(selfService.email, 'self-service-password-456')).length,
    ).toBeGreaterThan(0)

    const ownCookie = await loginCookie(actor.email, password)
    const ownPassword = await patch(
      jsonRequest(
        `/api/users/${actor.id}`,
        { password: 'actor-new-password-456' },
        ownCookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(actor.id)]),
    )
    expect(ownPassword.status).toBeLessThan(300)
    expect((await loginCookie(actor.email, 'actor-new-password-456')).length).toBeGreaterThan(0)
  })
})

function route(slug: string[]) {
  return { params: Promise.resolve({ slug }) }
}

function jsonRequest(
  path: string,
  body: unknown,
  cookie?: string,
  origin = ORIGIN,
  method = 'POST',
): Request {
  const headers = new Headers({
    'content-type': 'application/json',
    origin,
  })
  if (cookie) {
    headers.set('cookie', cookie)
  }
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  })
}

function cookieHeader(response: Response): string {
  const cookies = response.headers.getSetCookie?.() ?? []
  const parts = cookies.length > 0 ? cookies : [response.headers.get('set-cookie') ?? '']
  return parts
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter((cookie) => cookie && cookie.includes('='))
    .join('; ')
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

async function grant(roleId: number, key: string): Promise<void> {
  await setRoleGrant(payload, {
    roleId,
    permissionId: await permissionIdFor(key),
    granted: true,
  })
}

async function createAccount(
  email: string,
  password: string,
  roles: number[],
): Promise<{ id: number; email: string }> {
  const user = await payload.create({
    collection: 'users',
    data: { email, password, roles },
    overrideAccess: true,
    context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
  })
  createdUserIds.push(user.id)
  return { id: Number(user.id), email: user.email }
}

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

async function loginCookie(email: string, password: string): Promise<string> {
  const response = await post(
    jsonRequest('/api/users/login', { email, password }),
    route(['users', 'login']),
  )
  expect(response.status).toBe(200)
  const cookie = cookieHeader(response)
  expect(cookie).toContain('payload-token=')
  return cookie
}

async function readResetToken(email: string): Promise<string | null> {
  const adapter = payload.db as {
    client?: {
      prepare: (query: string) => {
        bind: (...values: unknown[]) => {
          first: <T>() => Promise<T | null>
        }
      }
    }
  }
  const row = await adapter.client
    ?.prepare('SELECT reset_password_token FROM users WHERE email = ?')
    .bind(email)
    .first<{ reset_password_token?: string | null }>()
  return row?.reset_password_token ?? null
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
