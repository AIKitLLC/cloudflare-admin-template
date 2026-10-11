// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { GRAPHQL_POST, REST_DELETE, REST_GET, REST_PATCH, REST_POST } from '@payloadcms/next/routes'
import { getPayload, type CollectionSlug, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SUPER_ADMIN_SLUG } from '@/access/constants'
import { relationIds } from '@/access/relation-id'
import config from '@/payload.config'
import { PRIVILEGED_USER_ERROR } from '@/rbac/guards/privilege-errors'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/rbac/guards/privilege-context'
import {
  SCOPE_ASSIGNMENT_ERROR,
  SCOPE_GRANT_ERROR,
  SCOPE_RECORD_ERROR,
  SCOPE_ROLE_TARGET_ERROR,
  SCOPE_TARGET_KEYS_ERROR,
  SCOPE_USER_ERROR,
  SELF_SCOPE_ASSIGNMENT_ERROR,
} from '@/scope/errors'
import {
  BRANCHES_SLUG,
  MAX_DIRECT_ASSIGNMENTS,
  ORGANIZATIONS_SLUG,
  RECORDS_SLUG,
} from '@/scope/constants'
import {
  cleanupRowScopeFixture,
  grantKey,
  seedRowScopeFixture,
  type RowScopeFixture,
} from '../helpers/row-scope-fixture'

const ORIGIN = 'http://localhost:3000'
const post = REST_POST(config)
const patch = REST_PATCH(config)
const get = REST_GET(config)
const remove = REST_DELETE(config)
const graphql = GRAPHQL_POST(config)

let payload: Payload
let fixture: RowScopeFixture
let cookie = ''

describe('row scope HTTP and GraphQL', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    fixture = await seedRowScopeFixture(payload, `${Date.now()}-http`)
    const login = await post(
      jsonRequest('/api/users/login', {
        email: fixture.actor.email,
        password: fixture.actor.password,
      }),
      route(['users', 'login']),
    )
    expect(login.status).toBe(200)
    cookie = cookieHeader(login)
    expect(cookie).toContain('payload-token=')
  }, 120000)

  afterAll(async () => {
    if (!payload || !fixture) return
    await cleanupRowScopeFixture(payload, fixture)
  }, 120000)

  it('scopes REST lists, counts, pagination, reads, updates, deletes, creates, and export', async () => {
    const page = await get(getRequest(`/api/records?limit=1&page=1`), route(['records']))
    expect(page.status).toBe(200)
    const pageBody = (await page.json()) as {
      docs: Array<{ id: number; title?: string }>
      hasNextPage: boolean
      totalDocs: number
      totalPages: number
    }
    expect(pageBody.totalDocs).toBe(3)
    expect(pageBody.totalPages).toBe(3)
    expect(pageBody.docs).toHaveLength(1)
    expect(pageBody.hasNextPage).toBe(true)
    const firstId = pageBody.docs[0].id

    const nextPage = await get(getRequest('/api/records?limit=1&page=2'), route(['records']))
    const nextBody = (await nextPage.json()) as { docs: Array<{ id: number }>; totalDocs: number }
    expect(nextBody.totalDocs).toBe(3)
    expect(nextBody.docs[0].id).not.toBe(firstId)

    const counted = await get(getRequest('/api/records/count'), route(['records', 'count']))
    expect(counted.status).toBe(200)
    expect(await counted.json()).toMatchObject({ totalDocs: 3 })

    const hidden = await get(
      getRequest(`/api/records/${fixture.eastRecordId}`),
      route(['records', String(fixture.eastRecordId)]),
    )
    expect(hidden.status).toBe(404)

    const crossUpdate = await patch(
      jsonRequest(
        `/api/records/${fixture.eastRecordId}`,
        { title: 'cross' },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['records', String(fixture.eastRecordId)]),
    )
    expect(crossUpdate.status).toBeGreaterThanOrEqual(400)
    const east = await payload.findByID({
      collection: RECORDS_SLUG,
      id: fixture.eastRecordId,
      overrideAccess: true,
    })
    expect(east.title).toBe(fixture.eastTitle)

    const retag = await patch(
      jsonRequest(
        `/api/records/${fixture.westRecordId}`,
        { organization: fixture.eastId },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['records', String(fixture.westRecordId)]),
    )
    expect(retag.status).toBe(403)
    expect(JSON.stringify(await retag.json())).toContain(SCOPE_RECORD_ERROR)

    const crossDelete = await remove(
      getRequest(`/api/records/${fixture.eastRecordId}`, 'DELETE'),
      route(['records', String(fixture.eastRecordId)]),
    )
    expect(crossDelete.status).toBeGreaterThanOrEqual(400)
    const eastAfterDelete = await payload.findByID({
      collection: RECORDS_SLUG,
      id: fixture.eastRecordId,
      overrideAccess: true,
    })
    expect(eastAfterDelete.title).toBe(fixture.eastTitle)

    const created = await post(
      jsonRequest(
        '/api/records',
        {
          title: `HTTP outside ${fixture.stamp}`,
          organization: fixture.eastId,
          branch: fixture.eastBranchId,
          dataClass: fixture.piiId,
        },
        cookie,
      ),
      route(['records']),
    )
    expect(created.status).toBe(403)
    expect(JSON.stringify(await created.json())).toContain(SCOPE_RECORD_ERROR)

    const allowed = await post(
      jsonRequest(
        '/api/records',
        {
          title: `HTTP inside ${fixture.stamp}`,
          organization: fixture.westId,
          branch: fixture.westSubBranchId,
          dataClass: fixture.piiId,
        },
        cookie,
      ),
      route(['records']),
    )
    expect(allowed.status).toBeLessThan(300)
    const allowedBody = (await allowed.json()) as { doc?: { id?: number } }
    fixture.recordIds.push(Number(allowedBody.doc?.id))

    const exported = await get(getRequest('/api/records/export'), route(['records', 'export']))
    expect(exported.status).toBe(200)
    const csv = await exported.text()
    expect(csv).toContain(fixture.westTitle)
    expect(csv).toContain(fixture.westChildTitle)
    expect(csv).not.toContain(fixture.eastTitle)
    expect(csv).not.toContain(fixture.publicTitle)
    expect(csv).toContain(`HTTP inside ${fixture.stamp}`)
  })

  it('scopes GraphQL lists, updates, and creates', async () => {
    const listed = await graphql(
      jsonRequest('/api/graphql', {
        query: `query {
          Records(limit: 10, page: 1) { totalDocs docs { id title } }
        }`,
      }),
    )
    const listedText = JSON.stringify(await listed.json())
    expect(listedText).toContain(fixture.westTitle)
    expect(listedText).toContain(`HTTP inside ${fixture.stamp}`)
    expect(listedText).toContain('"totalDocs":4')
    expect(listedText).not.toContain(fixture.eastTitle)
    expect(listedText).not.toContain(fixture.publicTitle)

    const updated = await graphql(
      jsonRequest('/api/graphql', {
        query: `mutation Update($id: Int!, $title: String) {
          updateRecord(id: $id, data: { title: $title }) { id }
        }`,
        variables: { id: fixture.eastRecordId, title: 'graphql-cross' },
      }),
    )
    expect(JSON.stringify(await updated.json())).toMatch(/not found|forbidden|not allowed/i)

    const created = await graphql(
      jsonRequest('/api/graphql', {
        query: `mutation Create($organization: Int!, $branch: Int!, $dataClass: Int!) {
          createRecord(data: { title: "graphql-outside", organization: $organization, branch: $branch, dataClass: $dataClass }) { id }
        }`,
        variables: {
          organization: fixture.eastId,
          branch: fixture.eastBranchId,
          dataClass: fixture.piiId,
        },
      }),
    )
    expect(JSON.stringify(await created.json())).toContain(SCOPE_RECORD_ERROR)
  })

  it('refuses scope escalation over REST, GraphQL, and the grant endpoint', async () => {
    const selfEdit = await patch(
      jsonRequest(
        `/api/users/${fixture.actor.id}`,
        { organizations: [fixture.westId, fixture.eastId] },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(fixture.actor.id)]),
    )
    expect(selfEdit.status).toBe(403)
    expect(JSON.stringify(await selfEdit.json())).toContain(SELF_SCOPE_ASSIGNMENT_ERROR)

    const graphqlSelf = await graphql(
      jsonRequest('/api/graphql', {
        query: `mutation Self($id: Int!, $organizations: [Int]) {
          updateUser(id: $id, data: { organizations: $organizations }) { id }
        }`,
        variables: { id: fixture.actor.id, organizations: [fixture.westId, fixture.eastId] },
      }),
    )
    expect(JSON.stringify(await graphqlSelf.json())).toContain(SELF_SCOPE_ASSIGNMENT_ERROR)

    const wider = await patch(
      jsonRequest(
        `/api/users/${fixture.childUser.id}`,
        { organizations: [fixture.westChildId, fixture.eastId] },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(fixture.childUser.id)]),
    )
    expect(wider.status).toBe(403)
    expect(JSON.stringify(await wider.json())).toContain(SCOPE_ASSIGNMENT_ERROR)

    const recordsUpdate = await permissionId('records:update')
    const restGrant = await post(
      jsonRequest(
        '/api/role-permissions',
        { role: fixture.outsideRoleId, permission: recordsUpdate, granted: true },
        cookie,
      ),
      route(['role-permissions']),
    )
    expect(restGrant.status).toBe(403)
    expect(JSON.stringify(await restGrant.json())).toContain(SCOPE_GRANT_ERROR)

    const endpointGrant = await post(
      jsonRequest(
        '/api/rbac/grants',
        { roleId: fixture.outsideRoleId, permissionId: recordsUpdate, granted: true },
        cookie,
      ),
      route(['rbac', 'grants']),
    )
    expect(endpointGrant.status).toBe(403)
    expect(await endpointGrant.json()).toMatchObject({ error: SCOPE_GRANT_ERROR })

    const graphqlGrant = await graphql(
      jsonRequest('/api/graphql', {
        query: `mutation Grant($role: Int!, $permission: Int!) {
          createRolePermission(data: { role: $role, permission: $permission, granted: true }) { id }
        }`,
        variables: { role: fixture.outsideRoleId, permission: recordsUpdate },
      }),
    )
    expect(JSON.stringify(await graphqlGrant.json())).toContain(SCOPE_GRANT_ERROR)

    const allowedGrant = await post(
      jsonRequest(
        '/api/rbac/grants',
        { roleId: fixture.insideRoleId, permissionId: recordsUpdate, granted: true },
        cookie,
      ),
      route(['rbac', 'grants']),
    )
    expect(allowedGrant.status).toBe(200)

    const roleTarget = await patch(
      jsonRequest(
        `/api/users/${fixture.eastUser.id}`,
        { roles: [fixture.outsideRoleId, fixture.freshRoleId] },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(fixture.eastUser.id)]),
    )
    expect(roleTarget.status).toBe(403)
    expect(JSON.stringify(await roleTarget.json())).toContain(SCOPE_ROLE_TARGET_ERROR)

    const graphqlRole = await graphql(
      jsonRequest('/api/graphql', {
        query: `mutation Assign($id: Int!, $roles: [Int]) {
          updateUser(id: $id, data: { roles: $roles }) { id }
        }`,
        variables: {
          id: fixture.eastUser.id,
          roles: [fixture.outsideRoleId, fixture.freshRoleId],
        },
      }),
    )
    expect(JSON.stringify(await graphqlRole.json())).toContain(SCOPE_ROLE_TARGET_ERROR)

    const insideAssign = await patch(
      jsonRequest(
        `/api/users/${fixture.childUser.id}`,
        { roles: [fixture.insideRoleId, fixture.freshRoleId] },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(fixture.childUser.id)]),
    )
    expect(insideAssign.status).toBeLessThan(300)
  })

  it('hides cross-org users and refuses scope grants to a more privileged user', async () => {
    const listed = await get(
      getRequest(`/api/users?where[email][equals]=${encodeURIComponent(fixture.eastUser.email)}`),
      route(['users']),
    )
    expect(listed.status).toBe(200)
    const listedText = JSON.stringify(await listed.json())
    expect(listedText).toContain('"totalDocs":0')
    expect(listedText).not.toContain(fixture.eastUser.email)
    const visible = await get(
      getRequest(`/api/users?where[email][equals]=${encodeURIComponent(fixture.childUser.email)}`),
      route(['users']),
    )
    const visibleText = JSON.stringify(await visible.json())
    expect(visibleText).toContain('"totalDocs":1')
    expect(visibleText).toContain(fixture.childUser.email)

    const hidden = await get(
      getRequest(`/api/users/${fixture.eastUser.id}`),
      route(['users', String(fixture.eastUser.id)]),
    )
    expect(hidden.status).toBe(404)

    const takeover = await patch(
      jsonRequest(
        `/api/users/${fixture.eastUser.id}`,
        { password: 'taken-over-password' },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(fixture.eastUser.id)]),
    )
    expect(takeover.status).toBeGreaterThanOrEqual(400)
    const stillHidden = await payload.findByID({
      collection: 'users',
      id: fixture.eastUser.id,
      overrideAccess: true,
    })
    expect(stillHidden.email).toBe(fixture.eastUser.email)
    const oldLogin = await post(
      jsonRequest(
        '/api/users/login',
        { email: fixture.eastUser.email, password: fixture.eastUser.password },
        '',
      ),
      route(['users', 'login']),
    )
    expect(oldLogin.status).toBe(200)
    const newLogin = await post(
      jsonRequest(
        '/api/users/login',
        { email: fixture.eastUser.email, password: 'taken-over-password' },
        '',
      ),
      route(['users', 'login']),
    )
    expect(newLogin.status).toBeGreaterThanOrEqual(400)

    const removed = await remove(
      getRequest(`/api/users/${fixture.eastUser.id}`, 'DELETE'),
      route(['users', String(fixture.eastUser.id)]),
    )
    expect(removed.status).toBeGreaterThanOrEqual(400)

    const graphqlHidden = await graphql(
      jsonRequest('/api/graphql', {
        query: `query Hidden($id: Int!) {
          Users(where: { id: { equals: $id } }) { totalDocs docs { email } }
        }`,
        variables: { id: fixture.eastUser.id },
      }),
    )
    const graphqlHiddenText = JSON.stringify(await graphqlHidden.json())
    expect(graphqlHiddenText).toContain('"totalDocs":0')
    expect(graphqlHiddenText).not.toContain(fixture.eastUser.email)

    const graphqlVisible = await graphql(
      jsonRequest('/api/graphql', {
        query: `query Visible($id: Int!) {
          Users(where: { id: { equals: $id } }) { totalDocs docs { email } }
        }`,
        variables: { id: fixture.childUser.id },
      }),
    )
    expect(JSON.stringify(await graphqlVisible.json())).toContain(fixture.childUser.email)

    await grantKey(payload, fixture.insideRoleId, 'media:read')
    const extend = await patch(
      jsonRequest(
        `/api/users/${fixture.childUser.id}`,
        { organizations: [fixture.westChildId, fixture.westId] },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(fixture.childUser.id)]),
    )
    expect(extend.status).toBe(403)
    expect(JSON.stringify(await extend.json())).toContain(SCOPE_TARGET_KEYS_ERROR)
    const child = await payload.findByID({
      collection: 'users',
      id: fixture.childUser.id,
      depth: 0,
      overrideAccess: true,
    })
    expect(relationIds(child.organizations)).toEqual([String(fixture.westChildId)])

    const peer = await patch(
      jsonRequest(
        `/api/users/${fixture.emptyUser.id}`,
        { organizations: [fixture.westId], dataClasses: [fixture.sensitiveId] },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(fixture.emptyUser.id)]),
    )
    expect(peer.status).toBeGreaterThanOrEqual(400)
    const peerDoc = await payload.findByID({
      collection: 'users',
      id: fixture.emptyUser.id,
      depth: 0,
      overrideAccess: true,
    })
    expect(relationIds(peerDoc.organizations)).toEqual([])
  })

  it('refuses GraphQL by-id changes and document access for an out-of-scope user', async () => {
    const graphqlById = await graphql(
      jsonRequest('/api/graphql', {
        query: `query One($id: Int!) {
          User(id: $id) { id email }
        }`,
        variables: { id: fixture.eastUser.id },
      }),
    )
    const graphqlByIdText = JSON.stringify(await graphqlById.json())
    expect(graphqlByIdText).not.toContain(fixture.eastUser.email)
    expect(graphqlByIdText).not.toMatch(/"User":\{/)

    const graphqlUpdate = await graphql(
      jsonRequest('/api/graphql', {
        query: `mutation HideUpdate($id: Int!, $email: String) {
          updateUser(id: $id, data: { email: $email }) { id }
        }`,
        variables: { id: fixture.eastUser.id, email: `taken-${fixture.stamp}@example.com` },
      }),
    )
    expect(JSON.stringify(await graphqlUpdate.json())).not.toMatch(/"updateUser":\{/)

    const graphqlDelete = await graphql(
      jsonRequest('/api/graphql', {
        query: `mutation HideDelete($id: Int!) {
          deleteUser(id: $id) { id }
        }`,
        variables: { id: fixture.eastUser.id },
      }),
    )
    expect(JSON.stringify(await graphqlDelete.json())).not.toMatch(/"deleteUser":\{/)
    const stillThere = await payload.findByID({
      collection: 'users',
      id: fixture.eastUser.id,
      depth: 0,
      overrideAccess: true,
    })
    expect(stillThere.email).toBe(fixture.eastUser.email)

    const docAccess = await post(
      jsonRequest(`/api/users/access/${fixture.eastUser.id}`, {}),
      route(['users', 'access', String(fixture.eastUser.id)]),
    )
    expect(docAccess.status).toBe(200)
    const docAccessBody = (await docAccess.json()) as Record<string, unknown>
    expect(operationDenied(docAccessBody.read)).toBe(true)
    expect(operationDenied(docAccessBody.update)).toBe(true)
    expect(operationDenied(docAccessBody.delete)).toBe(true)
    expect(operationDenied(docAccessBody.unlock)).toBe(true)

    const ownAccess = await post(
      jsonRequest(`/api/users/access/${fixture.actor.id}`, {}),
      route(['users', 'access', String(fixture.actor.id)]),
    )
    expect(ownAccess.status).toBe(200)
    const ownAccessBody = (await ownAccess.json()) as Record<string, unknown>
    expect(ownAccessBody.read).toBe(true)
    expect(ownAccessBody.update).toBe(true)
    expect(ownAccessBody.delete).toBe(true)
    expect(ownAccessBody.unlock).toBe(true)
  })

  it('keeps account-takeover refusals for in-scope and unscoped privileged users', async () => {
    const superAdminRole = await payload.find({
      collection: 'roles' as CollectionSlug,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { slug: { equals: SUPER_ADMIN_SLUG } },
    })
    const adminEmail = `scope-admin-${fixture.stamp}@example.com`
    const adminPassword = 'test-password-123'
    const admin = await payload.create({
      collection: 'users',
      data: {
        email: adminEmail,
        password: adminPassword,
        roles: [superAdminRole.docs[0].id],
      },
      overrideAccess: true,
      context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
    })
    fixture.userIds.push(Number(admin.id))

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
    expect(passwordPatch.status).toBeGreaterThanOrEqual(400)
    const adminLogin = await post(
      jsonRequest('/api/users/login', { email: adminEmail, password: adminPassword }, ''),
      route(['users', 'login']),
    )
    expect(adminLogin.status).toBe(200)
    const stolen = await post(
      jsonRequest('/api/users/login', { email: adminEmail, password: 'stolen-password-456' }, ''),
      route(['users', 'login']),
    )
    expect(stolen.status).toBeGreaterThanOrEqual(400)

    const graphqlPassword = await graphql(
      jsonRequest('/api/graphql', {
        query: `mutation Take($id: Int!, $password: String) {
          updateUser(id: $id, data: { password: $password }) { id }
        }`,
        variables: { id: Number(admin.id), password: 'stolen-password-456' },
      }),
    )
    const graphqlPasswordText = JSON.stringify(await graphqlPassword.json())
    expect(graphqlPasswordText).not.toMatch(/"updateUser":\{/)
    const stillOriginal = await post(
      jsonRequest('/api/users/login', { email: adminEmail, password: adminPassword }, ''),
      route(['users', 'login']),
    )
    expect(stillOriginal.status).toBe(200)

    const forgot = await post(
      jsonRequest('/api/users/forgot-password', { email: adminEmail }, cookie),
      route(['users', 'forgot-password']),
    )
    expect(forgot.status).toBe(403)
    expect(JSON.stringify(await forgot.json())).toContain(PRIVILEGED_USER_ERROR)

    const childPassword = await patch(
      jsonRequest(
        `/api/users/${fixture.childUser.id}`,
        { password: 'stolen-password-456' },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(fixture.childUser.id)]),
    )
    expect(childPassword.status).toBe(403)
    expect(JSON.stringify(await childPassword.json())).toContain(PRIVILEGED_USER_ERROR)
    const childLogin = await post(
      jsonRequest(
        '/api/users/login',
        { email: fixture.childUser.email, password: fixture.childUser.password },
        '',
      ),
      route(['users', 'login']),
    )
    expect(childLogin.status).toBe(200)

    const childDelete = await remove(
      getRequest(`/api/users/${fixture.childUser.id}`, 'DELETE'),
      route(['users', String(fixture.childUser.id)]),
    )
    expect(childDelete.status).toBe(403)
    expect(JSON.stringify(await childDelete.json())).toContain(PRIVILEGED_USER_ERROR)

    const edited = await patch(
      jsonRequest(
        `/api/users/${fixture.emptyUser.id}`,
        { email: `unused-${fixture.stamp}@example.com` },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['users', String(fixture.emptyUser.id)]),
    )
    expect(edited.status).toBeGreaterThanOrEqual(400)
    const stored = await payload.findByID({
      collection: 'users',
      id: fixture.emptyUser.id,
      overrideAccess: true,
    })
    expect(stored.email).toBe(fixture.emptyUser.email)
  })

  it('hides unscoped users and full-access users from a limited reader', async () => {
    const hidden = await get(
      getRequest(`/api/users/${fixture.emptyUser.id}`),
      route(['users', String(fixture.emptyUser.id)]),
    )
    expect(hidden.status).toBe(404)
    const listed = await get(
      getRequest(`/api/users?where[email][equals]=${encodeURIComponent(fixture.emptyUser.email)}`),
      route(['users']),
    )
    expect(JSON.stringify(await listed.json())).toContain('"totalDocs":0')

    const selfLogin = await post(
      jsonRequest(
        '/api/users/login',
        { email: fixture.emptyUser.email, password: fixture.emptyUser.password },
        '',
      ),
      route(['users', 'login']),
    )
    expect(selfLogin.status).toBe(200)
    const selfCookie = cookieHeader(selfLogin)
    const self = await get(
      authedGet(`/api/users/${fixture.emptyUser.id}`, selfCookie),
      route(['users', String(fixture.emptyUser.id)]),
    )
    expect(self.status).toBe(200)

    const superAdminRole = await payload.find({
      collection: 'roles' as CollectionSlug,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { slug: { equals: SUPER_ADMIN_SLUG } },
    })
    const admin = await payload.create({
      collection: 'users',
      data: {
        email: `scope-full-${fixture.stamp}@example.com`,
        password: 'test-password-123',
        roles: [superAdminRole.docs[0].id],
        organizations: [fixture.westId],
        dataClasses: [fixture.sensitiveId],
      },
      overrideAccess: true,
      context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
    })
    fixture.userIds.push(Number(admin.id))
    const adminHidden = await get(
      getRequest(`/api/users/${admin.id}`),
      route(['users', String(admin.id)]),
    )
    expect(adminHidden.status).toBe(404)

    const adminLogin = await post(
      jsonRequest(
        '/api/users/login',
        { email: `scope-full-${fixture.stamp}@example.com`, password: 'test-password-123' },
        '',
      ),
      route(['users', 'login']),
    )
    expect(adminLogin.status).toBe(200)
    const adminCookie = cookieHeader(adminLogin)
    const seenByAdmin = await get(
      authedGet(`/api/users/${fixture.emptyUser.id}`, adminCookie),
      route(['users', String(fixture.emptyUser.id)]),
    )
    expect(seenByAdmin.status).toBe(200)
    const seenSelf = await get(
      authedGet(`/api/users/${admin.id}`, adminCookie),
      route(['users', String(admin.id)]),
    )
    expect(seenSelf.status).toBe(200)
  })

  it('refuses to unlock a user outside the actor scope', async () => {
    await lockAccount(fixture.eastUser.email)
    await lockAccount(fixture.branchUser.email)

    const refused = await post(
      jsonRequest('/api/users/unlock', { email: fixture.eastUser.email.toUpperCase() }, cookie),
      route(['users', 'unlock']),
    )
    expect(refused.status).toBe(403)
    expect(JSON.stringify(await refused.json())).toContain(SCOPE_USER_ERROR)
    expect(await readLock(fixture.eastUser.email)).toBeTruthy()

    const allowed = await post(
      jsonRequest('/api/users/unlock', { email: fixture.branchUser.email }, cookie),
      route(['users', 'unlock']),
    )
    expect(allowed.status).toBe(200)
    expect(await readLock(fixture.branchUser.email)).toBeFalsy()
  })

  it('serves access and admin list and edit views without SQL', async () => {
    const access = await get(getRequest('/api/access'), route(['access']))
    expect(access.status).toBe(200)
    const accessBody = (await access.json()) as {
      collections: {
        records: { read: { permission?: boolean; where?: unknown } }
        users: { read: true | { permission?: boolean; where?: unknown } }
      }
    }
    const accessJson = JSON.stringify(accessBody)
    assertNoSql(accessJson)
    expect(accessJson.toLowerCase()).not.toContain('select ')
    expect(selfOnlyRead(accessBody.collections.users.read, fixture.actor.id)).toBe(true)
    expect(accessBody.collections.records.read.permission).toBe(true)
    expect(accessBody.collections.records.read.where).toBeTruthy()
    expect(accessJson).toContain('contains')

    await withAdminServer(async (base) => {
      await expectAdminPage(base, '/admin/collections/users', fixture.actor.email)
      await expectAdminPage(
        base,
        `/admin/collections/users/${fixture.actor.id}`,
        fixture.actor.email,
      )
      await expectAdminPage(base, '/admin/collections/records', fixture.westTitle)
      await expectAdminPage(
        base,
        `/admin/collections/records/${fixture.westRecordId}`,
        fixture.westTitle,
      )
    })
  }, 120000)

  it('filters more than 100 records at the assignment cap with a caller where', async () => {
    const orgIds: number[] = []
    const title = `Capped ${fixture.stamp}`
    let branchId: number | undefined
    let adminId: number | undefined
    let readerId: number | undefined
    try {
      for (let index = 0; index < MAX_DIRECT_ASSIGNMENTS - 1; index += 1) {
        const org = await payload.create({
          collection: ORGANIZATIONS_SLUG,
          data: {
            name: `Capped org ${fixture.stamp} ${index}`,
            slug: `capped-org-${fixture.stamp}-${index}`,
          },
          overrideAccess: true,
        })
        orgIds.push(Number(org.id))
      }
      const branch = await payload.create({
        collection: BRANCHES_SLUG,
        data: {
          name: `Capped branch ${fixture.stamp}`,
          slug: `capped-branch-${fixture.stamp}`,
          organization: orgIds[0],
        },
        overrideAccess: true,
      })
      branchId = Number(branch.id)
      await runSql(
        `WITH RECURSIVE nums(n) AS (
          SELECT 1
          UNION ALL
          SELECT n + 1 FROM nums WHERE n < 101
        )
        INSERT INTO records (title, organization_id, branch_id, data_class_id)
        SELECT ?, ?, ?, ? FROM nums`,
        title,
        orgIds[0],
        branchId,
        fixture.piiId,
      )
      await runSql(
        'INSERT INTO records (title, organization_id, branch_id, data_class_id) VALUES (?, ?, ?, ?)',
        title,
        fixture.eastId,
        fixture.eastBranchId,
        fixture.piiId,
      )
      const stored = await payload.count({
        collection: RECORDS_SLUG,
        overrideAccess: true,
        where: { title: { equals: title } },
      })
      expect(stored.totalDocs).toBe(102)

      const admin = await createHttpSuperAdmin()
      adminId = admin.id
      const reader = await payload.create({
        collection: 'users',
        data: {
          email: `capped-${fixture.stamp}@example.com`,
          password: 'test-password-123',
          roles: [fixture.actorRoleId],
          organizations: orgIds,
          dataClasses: [fixture.sensitiveId],
        },
        overrideAccess: false,
        user: httpUser(admin),
      })
      readerId = Number(reader.id)
      const login = await post(
        jsonRequest('/api/users/login', {
          email: `capped-${fixture.stamp}@example.com`,
          password: 'test-password-123',
        }),
        route(['users', 'login']),
      )
      expect(login.status).toBe(200)
      const page = await get(
        authedGet(
          `/api/records?limit=10&page=1&sort=title&where[title][contains]=${encodeURIComponent(title)}`,
          cookieHeader(login),
        ),
        route(['records']),
      )
      expect(page.status).toBe(200)
      const body = (await page.json()) as { totalDocs: number }
      expect(body.totalDocs).toBe(101)
    } finally {
      await runSql('DELETE FROM records WHERE title = ?', title)
      if (branchId !== undefined) {
        await payload.delete({
          collection: BRANCHES_SLUG,
          id: branchId,
          overrideAccess: true,
        })
      }
      for (const id of [readerId, adminId]) {
        if (id === undefined) continue
        await payload.delete({
          collection: 'users',
          id,
          overrideAccess: true,
          context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
        })
      }
      if (orgIds.length > 0) {
        await payload.delete({
          collection: ORGANIZATIONS_SLUG,
          where: { id: { in: orgIds } },
          overrideAccess: true,
        })
      }
    }
  }, 180000)

  it('lists and counts more than 1000 in-scope users without putting ids on access', async () => {
    const like = `crowd-${fixture.stamp}-%@example.com`
    try {
      for (let offset = 0; offset < 1000; offset += 100) {
        await runSql(
          `WITH RECURSIVE nums(n) AS (
            SELECT 0
            UNION ALL
            SELECT n + 1 FROM nums WHERE n + 1 < 100
          )
          INSERT INTO users (email, hash, salt)
          SELECT printf('crowd-%s-%d@example.com', ?, nums.n + ?), src.hash, src.salt
          FROM nums
          JOIN users AS src ON src.id = ?`,
          fixture.stamp,
          offset,
          fixture.actor.id,
        )
      }
      await runSql(
        `INSERT INTO users_rels ("order", parent_id, path, roles_id)
         SELECT 1, id, 'roles', ? FROM users WHERE email LIKE ?`,
        fixture.insideRoleId,
        like,
      )
      await runSql(
        `INSERT INTO users_rels ("order", parent_id, path, organizations_id)
         SELECT 1, id, 'organizations', ? FROM users WHERE email LIKE ?`,
        fixture.westId,
        like,
      )
      await runSql(
        `INSERT INTO users_rels ("order", parent_id, path, data_classes_id)
         SELECT 1, id, 'dataClasses', ? FROM users WHERE email LIKE ?`,
        fixture.sensitiveId,
        like,
      )

      const listed = await get(getRequest('/api/users?limit=1'), route(['users']))
      expect(listed.status).toBe(200)
      const listedBody = (await listed.json()) as { totalDocs: number }
      expect(listedBody.totalDocs).toBeGreaterThan(1000)
      const counted = await get(getRequest('/api/users/count'), route(['users', 'count']))
      expect(counted.status).toBe(200)
      const countedBody = (await counted.json()) as { totalDocs: number }
      expect(countedBody.totalDocs).toBe(listedBody.totalDocs)

      const hidden = await get(
        getRequest(`/api/users?where[email][equals]=${encodeURIComponent(fixture.eastUser.email)}`),
        route(['users']),
      )
      expect(hidden.status).toBe(200)
      expect(((await hidden.json()) as { totalDocs: number }).totalDocs).toBe(0)

      const access = await get(getRequest('/api/access'), route(['access']))
      expect(access.status).toBe(200)
      const accessBody = (await access.json()) as {
        collections: {
          users: Record<string, true | { permission?: boolean; where?: unknown }>
        }
      }
      const usersJson = JSON.stringify(accessBody.collections.users)
      const usersRead = JSON.stringify(accessBody.collections.users.read)
      expect(selfOnlyRead(accessBody.collections.users.read, fixture.actor.id)).toBe(true)
      expect(usersRead.length).toBeLessThan(200)
      expect(usersJson).not.toContain(`crowd-${fixture.stamp}-`)
      expect(usersJson).not.toContain('"in"')
    } finally {
      await runSql(
        'DELETE FROM users_rels WHERE parent_id IN (SELECT id FROM users WHERE email LIKE ?)',
        like,
      )
      await runSql('DELETE FROM users WHERE email LIKE ?', like)
    }
  }, 180000)
})

const SQL_MARKERS = ['case when', 'users_rels', 'querychunks', 'substr(']

function selfOnlyRead(
  read: true | { permission?: boolean; where?: { id?: { equals?: unknown } } },
  userId: number,
): boolean {
  if (read === true || !read.where) {
    return false
  }
  return read.permission === true && Number(read.where.id?.equals) === userId
}

function operationDenied(value: unknown): boolean {
  if (value === false || value === undefined) {
    return true
  }
  if (value && typeof value === 'object' && 'permission' in value) {
    return (value as { permission?: boolean }).permission === false
  }
  return false
}

function assertNoSql(value: string) {
  const text = value.toLowerCase()
  for (const marker of SQL_MARKERS) {
    expect(text).not.toContain(marker)
  }
}

async function expectAdminPage(base: string, path: string, marker: string) {
  const response = await fetch(`${base}${path}`, {
    // Payload drops the auth cookie unless Origin is on the CSRF allowlist.
    headers: { cookie, origin: ORIGIN },
    redirect: 'manual',
  })
  expect(response.status).toBe(200)
  const html = await response.text()
  expect(html).not.toContain('NEXT_REDIRECT')
  expect(html).not.toContain('"unauthenticated":true')
  expect(html).toContain(marker)
  assertNoSql(html)
}

async function withAdminServer(run: (base: string) => Promise<void>) {
  const port = 3456
  const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next')
  const child = spawn(process.execPath, [nextBin, 'dev', '--port', String(port)], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      PAYLOAD_SECRET: process.env.PAYLOAD_SECRET || 'test-secret-for-local-runs',
      // This server loads the config without the Vitest-only collection. A schema
      // push would drop that table while the test process still queries it.
      PAYLOAD_MIGRATING: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  try {
    await waitForServer(child, port, () => output)
    await run(`http://127.0.0.1:${port}`)
  } finally {
    stopProcess(child)
  }
}

async function waitForServer(child: ChildProcess, port: number, output: () => string) {
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Admin server exited ${child.exitCode}: ${output().slice(-2000)}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/admin/login`, { redirect: 'manual' })
      if (response.status < 500) {
        return
      }
    } catch {
      // The server is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Admin server did not start: ${output().slice(-2000)}`)
}

function stopProcess(child: ChildProcess) {
  if (child.pid === undefined) {
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

function route(slug: string[]) {
  return { params: Promise.resolve({ slug }) }
}

function jsonRequest(
  path: string,
  body: unknown,
  cookieHeaderValue?: string,
  origin = ORIGIN,
  method = 'POST',
): Request {
  const headers = new Headers({ 'content-type': 'application/json', origin })
  if (cookieHeaderValue ?? cookie) {
    headers.set('cookie', cookieHeaderValue ?? cookie)
  }
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  })
}

function getRequest(path: string, method = 'GET'): Request {
  const headers = new Headers({ origin: ORIGIN, cookie })
  return new Request(`${ORIGIN}${path}`, { method, headers })
}

function authedGet(path: string, token: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    headers: { origin: ORIGIN, cookie: token },
  })
}

function cookieHeader(response: Response): string {
  const cookies = response.headers.getSetCookie?.() ?? []
  const parts = cookies.length > 0 ? cookies : [response.headers.get('set-cookie') ?? '']
  return parts
    .map((value) => value.split(';')[0]?.trim())
    .filter((value) => value && value.includes('='))
    .join('; ')
}

async function lockAccount(email: string): Promise<void> {
  const until = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  await db()
    .prepare('UPDATE users SET login_attempts = 5, lock_until = ? WHERE email = ?')
    .bind(until, email)
    .run()
}

async function readLock(email: string): Promise<string | null> {
  const row = await db()
    .prepare('SELECT lock_until FROM users WHERE email = ?')
    .bind(email)
    .first<{ lock_until?: string | null }>()
  return row?.lock_until ?? null
}

async function runSql(query: string, ...values: unknown[]): Promise<void> {
  await db()
    .prepare(query)
    .bind(...values)
    .run()
}

async function createHttpSuperAdmin(): Promise<{ id: number; email: string }> {
  const role = await payload.find({
    collection: 'roles' as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { slug: { equals: SUPER_ADMIN_SLUG } },
  })
  const email = `scope-http-super-${fixture.stamp}@example.com`
  const user = await payload.create({
    collection: 'users',
    data: { email, password: 'test-password-123', roles: [role.docs[0].id] },
    overrideAccess: true,
    context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
  })
  return { id: Number(user.id), email }
}

function httpUser(user: { id: number; email: string }) {
  return {
    id: user.id,
    email: user.email,
    collection: 'users' as const,
    updatedAt: '',
    createdAt: '',
  }
}

function db(): {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => {
      first: <T>() => Promise<T | null>
      run: () => Promise<unknown>
    }
  }
} {
  const adapter = payload.db as {
    client?: {
      prepare: (query: string) => {
        bind: (...values: unknown[]) => {
          first: <T>() => Promise<T | null>
          run: () => Promise<unknown>
        }
      }
    }
  }
  if (!adapter.client) {
    throw new Error('D1 client is unavailable')
  }
  return adapter.client
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
