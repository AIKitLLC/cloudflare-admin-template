import { expect, test } from '@playwright/test'

import { createRole, setGrant, signInToken, uniqueSlug } from './helpers/access'
import { api } from './helpers/api'
import { createScopeTree, recordTitles, scopedReaderRole, scopedUser } from './helpers/scope'
import { adminToken, signInThroughUi, uniqueIp } from './helpers/sign-in'

const DENIED = 'You are not allowed to perform this action.'
const OUTSIDE_SCOPE = 'You cannot set a scope outside your own.'

const sorted = (values: string[]) => [...values].sort()

// The API cases pass explicit tokens, so no session cookie is needed.
test.use({ storageState: { cookies: [], origins: [] } })

test.describe('What a scoped user sees and may change', () => {
  test('a user scoped to an organization and a class sees only matching records', async ({
    request,
  }) => {
    const tree = await createScopeTree(request)
    const roleId = await scopedReaderRole(request)
    const inA = await scopedUser(request, {
      roleId,
      organizations: [tree.orgA],
      dataClasses: [tree.classPublic],
    })
    const nobody = await scopedUser(request, { roleId })
    const branchOnly = await scopedUser(request, {
      roleId,
      branches: [tree.brA1],
      dataClasses: [tree.classPublic, tree.classSecret],
    })

    const asA = await recordTitles(request, await signInToken(request, inA))
    const asNobody = await recordTitles(request, await signInToken(request, nobody))
    const asBranch = await recordTitles(request, await signInToken(request, branchOnly))
    const asAdmin = await recordTitles(request, adminToken(), tree.token)

    // The child organization is included; the secret class and organization B are not.
    expect(sorted(asA)).toEqual(sorted([tree.titles.aPublic, tree.titles.a1Public]))
    expect(asNobody).toEqual([])
    expect(asBranch).toEqual([tree.titles.a1Public])
    expect(asAdmin).toHaveLength(4)
  })

  test('an out-of-scope record is hidden by id and refused on write', async ({ request }) => {
    const tree = await createScopeTree(request)
    const user = await scopedUser(request, {
      roleId: await scopedReaderRole(request),
      organizations: [tree.orgA],
      dataClasses: [tree.classPublic],
    })
    const token = await signInToken(request, user)
    const outside = (id: number) => `/api/records/${id}`

    for (const id of [tree.records.bPublic, tree.records.aSecret]) {
      const read = await api(request, { method: 'GET', path: outside(id), token })
      expect(read).toMatchObject({ status: 404, message: 'Not Found' })
    }
    const edit = await api(request, {
      method: 'PATCH',
      path: outside(tree.records.bPublic),
      token,
      data: { title: 'hacked' },
    })
    const remove = await api(request, {
      method: 'DELETE',
      path: outside(tree.records.bPublic),
      token,
    })
    expect(edit).toMatchObject({ status: 403, message: DENIED })
    expect(remove).toMatchObject({ status: 403, message: DENIED })
    const stored = await api(request, {
      method: 'GET',
      path: outside(tree.records.bPublic),
      token: adminToken(),
    })
    expect(stored.body.title).toBe(tree.titles.bPublic)

    const inScope = await api(request, {
      method: 'PATCH',
      path: outside(tree.records.aPublic),
      token,
      data: { title: `${tree.token} edited` },
    })
    expect(inScope.status).toBe(200)
  })

  test('creating or moving a record outside the scope is refused', async ({ request }) => {
    const tree = await createScopeTree(request)
    const user = await scopedUser(request, {
      roleId: await scopedReaderRole(request),
      organizations: [tree.orgA],
      dataClasses: [tree.classPublic],
    })
    const token = await signInToken(request, user)
    const create = (data: Record<string, unknown>) =>
      api(request, { method: 'POST', path: '/api/records', token, data })

    const otherOrganization = await create({
      title: `${tree.token} x`,
      organization: tree.orgB,
      branch: tree.brB,
      dataClass: tree.classPublic,
    })
    const otherClass = await create({
      title: `${tree.token} x`,
      organization: tree.orgA,
      branch: tree.brA,
      dataClass: tree.classSecret,
    })
    const move = await api(request, {
      method: 'PATCH',
      path: `/api/records/${tree.records.aPublic}`,
      token,
      data: { organization: tree.orgB, branch: tree.brB },
    })
    const inside = await create({
      title: `${tree.token} new`,
      organization: tree.orgA,
      branch: tree.brA,
      dataClass: tree.classPublic,
    })

    expect(otherOrganization).toMatchObject({ status: 403, message: OUTSIDE_SCOPE })
    expect(otherClass).toMatchObject({ status: 403, message: OUTSIDE_SCOPE })
    expect(move).toMatchObject({ status: 403, message: OUTSIDE_SCOPE })
    expect(inside.status).toBe(201)
  })

  test('a user cannot change their own scope', async ({ request }) => {
    const tree = await createScopeTree(request)
    const user = await scopedUser(request, {
      roleId: await scopedReaderRole(request, ['users:update', 'users:writeField:organizations']),
      organizations: [tree.orgA],
      dataClasses: [tree.classPublic],
    })

    const attempt = await api(request, {
      method: 'PATCH',
      path: `/api/users/${user.id}`,
      token: await signInToken(request, user),
      data: { organizations: [tree.orgA, tree.orgB] },
    })

    expect(attempt).toMatchObject({
      status: 403,
      message: 'You cannot change your own scope assignments.',
    })
  })

  test("an admin widening a user's scope shows the new rows at once", async ({ request }) => {
    const tree = await createScopeTree(request)
    const user = await scopedUser(request, {
      roleId: await scopedReaderRole(request),
      organizations: [tree.orgA],
      dataClasses: [tree.classPublic],
    })
    const token = await signInToken(request, user)
    expect(await recordTitles(request, token)).not.toContain(tree.titles.bPublic)

    const widen = await api(request, {
      method: 'PATCH',
      path: `/api/users/${user.id}`,
      token: adminToken(),
      data: { organizations: [tree.orgA, tree.orgB] },
    })
    expect(widen.status).toBe(200)

    // The same token: scope is read on every request, not stored in the session.
    expect(await recordTitles(request, token)).toContain(tree.titles.bPublic)
  })
})

test.describe('Screens, export, users and the scope tree', () => {
  test('the records list shows a scoped user only their rows', async ({ page, request }) => {
    const tree = await createScopeTree(request)
    const user = await scopedUser(request, {
      roleId: await scopedReaderRole(request),
      organizations: [tree.orgA],
      dataClasses: [tree.classPublic],
    })

    await signInThroughUi(page, { ...user, ip: uniqueIp() })
    await page.waitForURL(/\/admin\/?$/)
    await page.goto('/admin/collections/records', { waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('row', { name: new RegExp(tree.titles.aPublic) })).toBeVisible()
    await expect(page.getByRole('row', { name: new RegExp(tree.titles.a1Public) })).toBeVisible()
    await expect(page.getByText(tree.titles.bPublic)).toHaveCount(0)
    await expect(page.getByText(tree.titles.aSecret)).toHaveCount(0)
  })

  test('an out-of-scope record URL shows nothing', async ({ page, request }) => {
    const tree = await createScopeTree(request)
    const user = await scopedUser(request, {
      roleId: await scopedReaderRole(request),
      organizations: [tree.orgA],
      dataClasses: [tree.classPublic],
    })
    await signInThroughUi(page, { ...user, ip: uniqueIp() })
    await page.waitForURL(/\/admin\/?$/)

    await page.goto(`/admin/collections/records/${tree.records.bPublic}`, {
      waitUntil: 'domcontentloaded',
    })

    await expect(page.locator('body')).toContainText(
      `The document with ID ${tree.records.bPublic} could not be found.`,
    )
    await expect(page.getByText(tree.titles.bPublic)).toHaveCount(0)
  })

  test('export carries only in-scope rows and needs the export grant', async ({ request }) => {
    const tree = await createScopeTree(request)
    const roleId = await scopedReaderRole(request)
    const user = await scopedUser(request, {
      roleId,
      organizations: [tree.orgA],
      dataClasses: [tree.classPublic],
    })
    const token = await signInToken(request, user)

    const refused = await api(request, { method: 'GET', path: '/api/records/export', token })
    expect(refused).toMatchObject({
      status: 403,
      message: 'You do not have export permission for this collection.',
    })

    expect(await setGrant(request, { roleId, key: 'records:export', granted: true })).toBe(200)
    const response = await request.get('/api/records/export', {
      headers: { authorization: `JWT ${token}` },
    })
    expect(response.status()).toBe(200)
    const [header, ...rows] = (await response.text()).trim().split('\n')
    expect(header).toBe('id,branch,createdAt,dataClass,organization,title,updatedAt')
    const titleColumn = header.split(',').indexOf('title')
    expect(sorted(rows.map((row) => row.split(',')[titleColumn]))).toEqual(
      sorted([tree.titles.aPublic, tree.titles.a1Public]),
    )
  })

  test('a users manager sees and edits only users in their scope', async ({ request }) => {
    const tree = await createScopeTree(request)
    const roleId = await createRole(request, {
      name: `Users manager ${uniqueSlug('r')}`,
      keys: [
        'users:read',
        'users:update',
        'users:readField:email',
        'users:readField:organizations',
        'users:readField:roles',
        'users:writeField:email',
        'organizations:read',
        'organizations:readField:name',
        'organizations:readField:slug',
      ],
    })
    const manager = await scopedUser(request, { roleId, organizations: [tree.orgA] })
    const inScope = await scopedUser(request, { organizations: [tree.orgA1] })
    const outOfScope = await scopedUser(request, { organizations: [tree.orgB] })
    const unassigned = await scopedUser(request, {})
    const token = await signInToken(request, manager)

    const list = await api(request, { method: 'GET', path: '/api/users?limit=100&depth=0', token })
    expect(sorted(list.body.docs.map((doc: { email: string }) => doc.email))).toEqual(
      sorted([manager.email, inScope.email]),
    )

    const read = await api(request, { method: 'GET', path: `/api/users/${outOfScope.id}`, token })
    expect(read).toMatchObject({ status: 404, message: 'Not Found' })
    const editOutside = await api(request, {
      method: 'PATCH',
      path: `/api/users/${outOfScope.id}`,
      token,
      data: { email: `renamed-${outOfScope.email}` },
    })
    expect(editOutside).toMatchObject({ status: 403, message: DENIED })
    const editUnassigned = await api(request, {
      method: 'PATCH',
      path: `/api/users/${unassigned.id}`,
      token,
      data: { email: `renamed-${unassigned.email}` },
    })
    expect(editUnassigned).toMatchObject({ status: 403, message: DENIED })

    const assign = await api(request, {
      method: 'PATCH',
      path: `/api/users/${inScope.id}`,
      token,
      data: { organizations: [tree.orgA1, tree.orgB] },
    })
    expect(assign).toMatchObject({
      status: 403,
      message: 'You can only assign scopes within your own scope.',
    })
    const editInside = await api(request, {
      method: 'PATCH',
      path: `/api/users/${inScope.id}`,
      token,
      data: { email: `renamed-${inScope.email}` },
    })
    expect(editInside.status).toBe(200)
  })

  test('the scope tree refuses deleting a used node and a cycle', async ({ request }) => {
    const tree = await createScopeTree(request)
    const token = adminToken()
    const inUse =
      'Remove nested scope nodes, records, and user assignments that still use this scope before deleting it.'
    const cycle = 'That scope parent would create a cycle or exceed the hierarchy depth.'

    const withChild = await api(request, {
      method: 'DELETE',
      path: `/api/organizations/${tree.orgA}`,
      token,
    })
    const withRecords = await api(request, {
      method: 'DELETE',
      path: `/api/branches/${tree.brA}`,
      token,
    })
    const underChild = await api(request, {
      method: 'PATCH',
      path: `/api/organizations/${tree.orgA}`,
      token,
      data: { parent: tree.orgA1 },
    })
    const underItself = await api(request, {
      method: 'PATCH',
      path: `/api/organizations/${tree.orgA}`,
      token,
      data: { parent: tree.orgA },
    })

    expect(withChild).toMatchObject({ status: 400, message: inUse })
    expect(withRecords).toMatchObject({ status: 400, message: inUse })
    expect(underChild).toMatchObject({ status: 400, message: cycle })
    expect(underItself).toMatchObject({ status: 400, message: cycle })
  })
})
