// Nexus CRM installed as its own Worker behind the `NEXUS` service binding (#44, ADR 0001). Runs
// against the third Worker (project `nexus`, only when E2E_NEXUS_DIR is set): its own template
// database with its own first admin, and a Nexus Worker on an empty local D1. Every call goes
// through the template's `/api/nexus/*`; nothing here talks to Nexus directly. The admin's email is
// also Nexus's OWNER_EMAIL, so its first bridged request meets an existing Nexus user.
import { randomBytes } from 'node:crypto'

import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

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

/** A user holding a role with exactly `keys` (none: a user without roles) and the given scope, signed in. */
async function userWith(
  request: APIRequestContext,
  keys: string[],
  scope: { organizations?: number[]; branches?: number[] } = {},
) {
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
    data: { email, password: PASSWORD, roles, ...scope },
  })
  expect(created.status).toBe(201)
  return { id: created.body.doc.id as number, email, token: await signIn(request, email, PASSWORD) }
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

  test('a user who changes their email keeps working in the CRM', async ({ request }) => {
    const writer = await userWith(request, ['nexus:write'])
    expect((await createRecord(request, writer.token, { objectKey: 'contact', title: 'before' })).status).toBe(201)
    const { body: me } = await api(request, { method: 'GET', path: '/api/users/me', token: writer.token })
    const renamed = await api(request, {
      method: 'PATCH',
      path: `/api/users/${me.user.id}`,
      token: adminJwt,
      data: { email: uniqueEmail('renamed') },
    })
    expect(renamed.status).toBe(200)
    expect((await createRecord(request, writer.token, { objectKey: 'contact', title: 'after' })).status).toBe(201)
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
    for (const path of ['/api/nexus/auth/login', '/api/nexus/auth/logout', '/api/nexus/bridge/mcp-token', '/api/nexus/mcp', '/api/nexus/v1']) {
      const result = await api(request, { method: 'GET', path, token: adminJwt })
      expect(result.status, path).not.toBe(200)
    }
    // `auth/me` is forwarded, read-only: the SPA reads the bridged actor from it.
    expect(
      await api(request, { method: 'POST', path: '/api/nexus/auth/me', token: adminJwt, data: {} }),
    ).toMatchObject({ status: 405 })
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

/** An organization (optionally under `parent`) and a branch in it, as the admin. */
async function organization(request: APIRequestContext, name: string, parent?: number) {
  const tag = randomBytes(4).toString('hex')
  const org = await api(request, {
    method: 'POST',
    path: '/api/organizations',
    token: adminJwt,
    data: { name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, ...(parent ? { parent } : {}) },
  })
  expect(org.status).toBe(201)
  const branch = await api(request, {
    method: 'POST',
    path: '/api/branches',
    token: adminJwt,
    data: { name: `${name} branch ${tag}`, slug: `${name.toLowerCase()}-br-${tag}`, organization: org.body.doc.id },
  })
  expect(branch.status).toBe(201)
  return { id: org.body.doc.id as number, name: org.body.doc.name as string, branch: branch.body.doc.id as number }
}

const inOrg = (orgId: number | 'default') => ({ 'x-nexus-org': String(orgId) })

test.describe('Organizations as Nexus workspaces', () => {
  test('a user works in their organizations and their descendants, each a separate workspace', async ({ request }) => {
    const a = await organization(request, 'Acme')
    const a1 = await organization(request, 'AcmeEast', a.id)
    const b = await organization(request, 'Bolt')
    const user = await userWith(request, ['nexus:write'], { organizations: [a.id] })

    const listed = await api(request, { method: 'GET', path: '/api/nexus/workspaces', token: user.token })
    expect(listed.status).toBe(200)
    expect(listed.body.items.map((item: { orgId: number }) => item.orgId).sort()).toEqual([a.id, a1.id].sort())

    const title = `In Acme ${randomBytes(4).toString('hex')}`
    const created = await api(request, {
      method: 'POST',
      path: '/api/nexus/v1/records',
      token: user.token,
      headers: inOrg(a.id),
      data: { objectKey: 'contact', title },
    })
    expect(created.status).toBe(201)
    expect(created.body.workspaceId).toMatch(new RegExp(`^ws_org_${a.id}_\\d+$`))

    const titles = async (orgId: number | 'default', token = user.token) => {
      const result = await api(request, {
        method: 'GET',
        path: '/api/nexus/v1/records?object=contact',
        token,
        headers: inOrg(orgId),
      })
      expect(result.status).toBe(200)
      return result.body.records.map((record: { title: string }) => record.title) as string[]
    }
    expect(await titles(a.id)).toContain(title)
    // No roll-up: the child organization is its own workspace.
    expect(await titles(a1.id)).not.toContain(title)
    // Asking for an organization outside the scope is not honoured.
    const outside = await api(request, { method: 'GET', path: '/api/nexus/workspaces', token: user.token, headers: inOrg(b.id) })
    expect(outside.body.items.find((item: { active: boolean }) => item.active).orgId).not.toBe(b.id)
    expect(await titles(b.id)).toContain(title)

    // A Super Admin sees every organization and the default workspace; B does not show A's record.
    const all = await api(request, { method: 'GET', path: '/api/nexus/workspaces', token: adminJwt })
    const orgIds = all.body.items.map((item: { orgId: number | null }) => item.orgId)
    expect(orgIds).toEqual(expect.arrayContaining([null, a.id, a1.id, b.id]))
    expect(await titles(b.id, adminJwt)).not.toContain(title)
    expect(await titles(a.id, adminJwt)).toContain(title)
  })

  test('a branch assignment alone does not open the organization; no assignment uses the default workspace', async ({
    request,
  }) => {
    const org = await organization(request, 'Cobalt')
    const branchOnly = await userWith(request, ['nexus:write'], { branches: [org.branch] })
    expect(
      await api(request, { method: 'GET', path: '/api/nexus/v1/records?object=contact', token: branchOnly.token }),
    ).toMatchObject({ status: 403, message: DENIED })

    const unassigned = await userWith(request, ['nexus:write'])
    const created = await api(request, {
      method: 'POST',
      path: '/api/nexus/v1/records',
      token: unassigned.token,
      data: { objectKey: 'contact', title: 'default workspace' },
    })
    expect(created).toMatchObject({ status: 201, body: { workspaceId: 'ws_e2e_crm' } })
  })
})

test.describe('The Nexus app under /nexus/', () => {
  test('serves the SPA, its assets and deep links to a signed-in user, with the Nexus CSP', async ({ request }) => {
    // A top-level navigation: Payload takes a session cookie only with an Origin or Sec-Fetch-Site.
    const headers = { cookie: `payload-token=${adminJwt}`, 'sec-fetch-site': 'none' }
    const page = await request.get('/nexus', { headers, maxRedirects: 0 })
    expect(page.status()).toBe(200)
    const html = await page.text()
    expect(html).toContain('/nexus/assets/')
    expect(page.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(page.headers()['cache-control']).toBe('private, no-store')
    expect(page.headers()['set-cookie']).toBeUndefined()
    const script = /src="(\/nexus\/assets\/[^"]+\.js)"/.exec(html)![1]
    const asset = await request.get(script, { headers })
    expect(asset.status()).toBe(200)
    expect(asset.headers()['content-type']).toContain('javascript')
    const deep = await request.get('/nexus/contacts', { headers, maxRedirects: 0 })
    expect(deep.status()).toBe(200)
    expect(await deep.text()).toContain('/nexus/assets/')
  })

  test('redirects a visitor to the admin login and refuses a user without a Nexus key', async ({ request }) => {
    const anonymous = await request.get('/nexus/contacts?x=1', { headers: { cookie: '' }, maxRedirects: 0 })
    expect(anonymous.status()).toBe(302)
    expect(anonymous.headers().location).toBe('/admin/login?redirect=%2Fnexus%2Fcontacts%3Fx%3D1')
    const outsider = await userWith(request, [])
    const refused = await request.get('/nexus', { headers: { cookie: `payload-token=${outsider.token}`, 'sec-fetch-site': 'none' }, maxRedirects: 0 })
    expect(refused.status()).toBe(403)
  })

  test('a non-asset /nexus/ path returns 404 and never reaches Nexus Worker routes', async ({ request }) => {
    const headers = { cookie: `payload-token=${adminJwt}`, 'sec-fetch-site': 'none' }
    for (const path of ['/nexus/api/health', '/nexus/api/v1/records', '/nexus/api/auth/login', '/nexus/mcp', '/nexus/api/health.js', '/nexus/mcp.js', '/nexus/api/bridge/mcp-token.map', '/nexus/%61pi/v1/records/x.js', '/nexus//api/health.js', '/nexus/API/health.js', '/nexus/%2e%2e/api']) {
      const response = await request.get(path, { headers, maxRedirects: 0 })
      expect(response.status(), path).toBe(404)
      expect(await response.text(), path).toMatch(/not found/i)
    }
    // API traffic still uses the authenticated bridge.
    const bridged = await api(request, { method: 'GET', path: '/api/nexus/health', token: adminJwt })
    expect(bridged).toMatchObject({ status: 200, body: { ok: true } })
  })

  test('the app runs in the browser with the template session', async ({ page }: { page: Page }) => {
    // page.request shares the browser's cookie jar, so userWith's sign-in is the page's session.
    const user = await userWith(page.request, ['nexus:write'])
    await page.goto('/admin', { waitUntil: 'domcontentloaded' })
    // The admin sidebar links to the app (it may be collapsed, so the link is checked, not clicked).
    await expect(page.getByRole('link', { name: 'Nexus CRM' })).toHaveAttribute('href', '/nexus')
    await page.goto('/nexus/contacts')
    // The profile chip shows the bridged template user, and the app called /api/nexus/*.
    await expect(page.locator('.profile-chip')).toContainText(user.email)
    expect(page.url()).toMatch(/\/nexus\/contacts$/)
    const me = await page.evaluate(() => fetch('/api/nexus/auth/me').then((r) => r.json()))
    expect(me).toMatchObject({ authenticated: true, actor: { email: user.email, role: 'member' } })
  })
})

test.describe('MCP through /api/nexus/mcp', () => {
  const rpc = (request: APIRequestContext, token: string, method: string, id = 1) =>
    request.post('/api/nexus/mcp', {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        cookie: '',
      },
      data:
        method === 'initialize'
          ? { jsonrpc: '2.0', id, method, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }
          : { jsonrpc: '2.0', id, method, params: {} },
    })

  async function mint(request: APIRequestContext, token: string) {
    const minted = await api(request, {
      method: 'POST',
      path: '/api/nexus/v1/mcp/tokens',
      token,
      data: { name: `e2e ${randomBytes(3).toString('hex')}`, scopes: ['crm:read'] },
    })
    expect(minted.status).toBe(201)
    return minted.body.token as string
  }

  test('a token minted through the template lists the tools', async ({ request }) => {
    const token = await mint(request, adminJwt)
    expect((await rpc(request, token, 'initialize')).status()).toBe(200)
    const tools = await rpc(request, token, 'tools/list', 2)
    expect(tools.status()).toBe(200)
    const body = await tools.json()
    expect(body.result.tools.length).toBeGreaterThan(0)
  })

  test('a token sent straight to the Nexus Worker, skipping the template, is refused', async ({ request, baseURL }) => {
    const token = await mint(request, adminJwt)
    // The Nexus Worker's own local port (scripts/e2e/serve-worker.mjs), like a workers.dev URL would be.
    const direct = `http://localhost:${Number(new URL(baseURL!).port) + 2}`
    const response = await request.post(`${direct}/mcp`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })
    expect(response.status()).toBe(401)
    expect((await request.get(`${direct}/api/v1/records?object=contact`)).status()).toBe(401)
  })

  test('an unknown token, and a token whose owner lost nexus:admin, are refused', async ({ request }) => {
    expect((await rpc(request, 'nxmcp_not_a_real_token', 'initialize')).status()).toBe(401)

    const admin = await userWith(request, ['nexus:admin'])
    const token = await mint(request, admin.token)
    expect((await rpc(request, token, 'initialize')).status()).toBe(200)

    const { body: me } = await api(request, { method: 'GET', path: '/api/users/me', token: admin.token })
    const roleId = me.user.roles[0].id ?? me.user.roles[0]
    const { body: permissions } = await api(request, {
      method: 'GET',
      path: '/api/permissions?where[key][equals]=nexus:admin&depth=0',
      token: adminJwt,
    })
    const revoked = await api(request, {
      method: 'POST',
      path: '/api/rbac/grants',
      token: adminJwt,
      data: { roleId, permissionId: permissions.docs[0].id, granted: false },
    })
    expect(revoked.status).toBe(200)
    // The owner made no CRM request since, so Nexus's own membership row still says admin.
    expect((await rpc(request, token, 'initialize', 3)).status()).toBe(401)
  })
})
