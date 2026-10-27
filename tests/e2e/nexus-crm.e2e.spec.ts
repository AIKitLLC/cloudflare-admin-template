// Nexus CRM installed as its own Worker behind the `NEXUS` service binding (#44, ADR 0001). Runs
// against the third Worker (project `nexus`, only when E2E_NEXUS_DIR is set): its own template
// database with its own first admin, and a Nexus Worker on an empty local D1. Every call goes
// through the template's `/api/nexus/*`; nothing here talks to Nexus directly.
import { randomBytes } from 'node:crypto'

import { expect, test, type APIRequestContext } from '@playwright/test'

import { api } from './helpers/api'
import { attemptSignIn, uniqueEmail, uniqueIp } from './helpers/sign-in'

const DENIED = 'You are not allowed to perform this action.'
const admin = { email: 'nexus-admin@example.com', password: 'nexus-admin-password-123' }
const PASSWORD = 'nexus-user-password-123'

test.describe.configure({ mode: 'serial' })
test.use({ storageState: { cookies: [], origins: [] } })

let adminJwt: string

async function signIn(request: APIRequestContext, email: string, password: string) {
  const result = await attemptSignIn(request, { email, password, ip: uniqueIp() })
  if (result.status !== 200 || !result.token) throw new Error(`Sign-in answered ${result.status}`)
  return result.token
}

/** A user holding a role with exactly `keys` (none: a user without roles), signed in. */
async function userWith(request: APIRequestContext, keys: string[]) {
  let roles: number[] = []
  if (keys.length > 0) {
    const role = await api(request, {
      method: 'POST',
      path: '/api/roles',
      token: adminJwt,
      data: { name: `Nexus ${randomBytes(3).toString('hex')}`, slug: `nexus-${randomBytes(4).toString('hex')}` },
    })
    expect(role.status).toBe(201)
    const { body } = await api(request, {
      method: 'GET',
      path: '/api/permissions?limit=500&depth=0',
      token: adminJwt,
    })
    const ids = new Map((body.docs as { key: string; id: number }[]).map((doc) => [doc.key, doc.id]))
    for (const key of keys) {
      const grant = await api(request, {
        method: 'POST',
        path: '/api/rbac/grants',
        token: adminJwt,
        data: { roleId: role.body.doc.id, permissionId: ids.get(key), granted: true },
      })
      expect(grant.status, key).toBe(200)
    }
    roles = [role.body.doc.id]
  }
  const email = uniqueEmail('nexus')
  const created = await api(request, {
    method: 'POST',
    path: '/api/users',
    token: adminJwt,
    data: { email, password: PASSWORD, roles },
  })
  expect(created.status).toBe(201)
  return { email, token: await signIn(request, email, PASSWORD) }
}

const createRecord = (request: APIRequestContext, token: string, data: unknown) =>
  api(request, { method: 'POST', path: '/api/nexus/v1/records', token, data })
const listRecords = (request: APIRequestContext, token: string, object: string) =>
  api(request, { method: 'GET', path: `/api/nexus/v1/records?object=${object}`, token })

test.beforeAll(async ({ request, baseURL }) => {
  const registered = await api(request, {
    method: 'POST',
    path: '/api/users/first-register',
    ip: uniqueIp(),
    headers: { origin: baseURL! },
    data: { ...admin, 'confirm-password': admin.password },
  })
  // 403 when a retry finds the admin already created.
  expect([200, 403]).toContain(registered.status)
  adminJwt = await signIn(request, admin.email, admin.password)
})

test.describe('Nexus CRM through the service binding', () => {
  test('the Nexus permissions are in the catalog while the binding exists', async ({ request }) => {
    const { body } = await api(request, {
      method: 'GET',
      path: '/api/permissions?where[key][like]=nexus:&limit=10&depth=0',
      token: adminJwt,
    })
    expect((body.docs as { key: string }[]).map((doc) => doc.key).sort()).toEqual([
      'nexus:admin',
      'nexus:read',
      'nexus:write',
    ])
  })

  test('a Super Admin creates and lists contacts and deals as the Nexus owner', async ({ request }) => {
    const tag = randomBytes(4).toString('hex')
    const contact = await createRecord(request, adminJwt, {
      objectKey: 'contact',
      title: `Ada ${tag}`,
      data: { full_name: `Ada ${tag}`, email: `ada-${tag}@example.test` },
    })
    expect(contact.status).toBe(201)
    expect(contact.body).toMatchObject({ objectKey: 'contact', title: `Ada ${tag}`, workspaceId: 'ws_e2e_crm' })
    const deal = await createRecord(request, adminJwt, {
      objectKey: 'deal',
      title: `Deal ${tag}`,
      data: { amount: 1200 },
    })
    expect(deal.status).toBe(201)

    const contacts = await listRecords(request, adminJwt, 'contact')
    const deals = await listRecords(request, adminJwt, 'deal')
    expect(contacts.status).toBe(200)
    expect(contacts.body.records.map((r: { title: string }) => r.title)).toContain(`Ada ${tag}`)
    expect(deals.body.records.map((r: { title: string }) => r.title)).toContain(`Deal ${tag}`)
    expect(contacts.body.records.every((r: { objectKey: string }) => r.objectKey === 'contact')).toBe(true)

    // The bridged actor: the template user, mapped into the installation workspace.
    const me = await api(request, { method: 'GET', path: '/api/nexus/v1/overview', token: adminJwt })
    expect(me.status).toBe(200)
  })

  test('nexus:write creates; nexus:read only reads; no key, no access', async ({ request }) => {
    const writer = await userWith(request, ['nexus:write'])
    const reader = await userWith(request, ['nexus:read'])
    const outsider = await userWith(request, [])
    const tag = randomBytes(4).toString('hex')

    const written = await createRecord(request, writer.token, { objectKey: 'contact', title: `By writer ${tag}` })
    expect(written.status).toBe(201)

    const read = await listRecords(request, reader.token, 'contact')
    expect(read.status).toBe(200)
    expect(read.body.records.map((r: { title: string }) => r.title)).toContain(`By writer ${tag}`)
    expect(await createRecord(request, reader.token, { objectKey: 'contact', title: 'refused' })).toMatchObject({
      status: 403,
      message: DENIED,
    })

    expect(await listRecords(request, outsider.token, 'contact')).toMatchObject({ status: 403, message: DENIED })
    expect(await listRecords(request, '', 'contact')).toMatchObject({ status: 401, message: DENIED })
  })

  test('a grant removed takes effect on the next request', async ({ request }) => {
    const writer = await userWith(request, ['nexus:write'])
    expect((await listRecords(request, writer.token, 'contact')).status).toBe(200)
    const { body: me } = await api(request, { method: 'GET', path: '/api/users/me', token: writer.token })
    const roleId = me.user.roles[0].id ?? me.user.roles[0]
    const { body: permissions } = await api(request, {
      method: 'GET',
      path: '/api/permissions?where[key][equals]=nexus:write&depth=0',
      token: adminJwt,
    })
    const revoked = await api(request, {
      method: 'POST',
      path: '/api/rbac/grants',
      token: adminJwt,
      data: { roleId, permissionId: permissions.docs[0].id, granted: false },
    })
    expect(revoked.status).toBe(200)
    expect(await listRecords(request, writer.token, 'contact')).toMatchObject({ status: 403, message: DENIED })
  })

  test('only CRM API paths are forwarded, never Nexus sign-in', async ({ request }) => {
    for (const path of ['/api/nexus/auth/login', '/api/nexus/auth/me', '/api/nexus/mcp', '/api/nexus/v1']) {
      const result = await api(request, { method: 'GET', path, token: adminJwt })
      expect(result.status, path).not.toBe(200)
    }
    const health = await api(request, { method: 'GET', path: '/api/nexus/health', token: adminJwt })
    expect(health).toMatchObject({ status: 200, body: { ok: true, deliveryMode: 'disabled' } })
  })

  test('a write from another origin is refused', async ({ request }) => {
    const result = await api(request, {
      method: 'POST',
      path: '/api/nexus/v1/records',
      token: adminJwt,
      headers: { origin: 'https://evil.example' },
      data: { objectKey: 'contact', title: 'cross-site' },
    })
    expect(result).toMatchObject({ status: 403, message: DENIED })
  })

  test('the caller cannot forge the identity header, and no Nexus cookie comes back', async ({ request }) => {
    const reader = await userWith(request, ['nexus:read'])
    const forged = await api(request, {
      method: 'POST',
      path: '/api/nexus/v1/records',
      token: reader.token,
      headers: { 'x-nexus-identity': 'v1.e30.00' },
      data: { objectKey: 'contact', title: 'forged' },
    })
    expect(forged.status).toBe(403)

    const response = await request.get('/api/nexus/v1/records?object=contact', {
      headers: { authorization: `JWT ${adminJwt}`, cookie: '' },
    })
    expect(response.status()).toBe(200)
    expect(response.headers()['set-cookie']).toBeUndefined()
    expect(response.headers()['cache-control']).toBe('private, no-store')
  })
})
