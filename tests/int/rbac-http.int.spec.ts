// @vitest-environment node
import { GRAPHQL_POST, REST_PATCH, REST_POST } from '@payloadcms/next/routes'
import { getPayload, type CollectionSlug, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { SUBSET_ASSIGNMENT_ERROR, SUBSET_GRANT_ERROR } from '@/rbac/guards/privilege-errors'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/rbac/guards/privilege-context'
import { setRoleGrant } from '@/rbac/matrix/set-role-grant'

const ORIGIN = 'http://localhost:3000'
const post = REST_POST(config)
const patch = REST_PATCH(config)
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
