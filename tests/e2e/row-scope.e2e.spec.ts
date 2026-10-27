import { expect, test } from '@playwright/test'

import { createRole, setGrant, signInToken, uniqueSlug } from './helpers/access'
import { api } from './helpers/api'
import {
  createScopeTree,
  recordTitles,
  scopedReaderRole,
  scopedUser,
  scopeNames,
} from './helpers/scope'
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
    const tokenA = await signInToken(request, inA)
    const names = (collection: string) => scopeNames(request, tokenA, collection)

    // The child organization is included; the secret class and organization B are not.
    expect(sorted(asA)).toEqual(sorted([tree.titles.aPublic, tree.titles.a1Public]))
    expect(asNobody).toEqual([])
    expect(asBranch).toEqual([tree.titles.a1Public])
    expect(asAdmin).toHaveLength(4)

    // The scope nodes themselves are filtered the same way: the organization and its child, the
    // branches under them, and only the assigned class.
    expect(sorted(await names('organizations'))).toEqual(
      sorted([`Org A ${tree.token}`, `Org A1 ${tree.token}`]),
    )
    expect(sorted(await names('branches'))).toEqual(
      sorted([`Branch A ${tree.token}`, `Branch A1 ${tree.token}`]),
    )
    expect(await names('data-classes')).toEqual([`Public ${tree.token}`])

    // The admin screens read the same filter from /api/access.
    const access = await api(request, { method: 'GET', path: '/api/access', token: tokenA })
    expect(JSON.stringify(access.body.collections.records.read.where)).toContain(
      `"organization.scopePath":{"contains":"/${tree.orgA}/"}`,
    )
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

    const own = await api(request, {
      method: 'POST',
      path: '/api/records',
      token,
      data: {
        title: `${tree.token} own`,
        organization: tree.orgA,
        branch: tree.brA,
        dataClass: tree.classPublic,
      },
    })
    expect(own.status).toBe(201)
    // The same user can delete a record inside their scope, so the 403 above is the scope.
    const removeOwn = await api(request, {
      method: 'DELETE',
      path: outside(own.body.doc.id),
      token,
    })
    expect(removeOwn.status).toBe(200)

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
    expect(sorted(await recordTitles(request, token))).toEqual(
      sorted([tree.titles.aPublic, tree.titles.a1Public, tree.titles.bPublic]),
    )
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
        'users:writeField:organizations',
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
    const make = async (collection: string, data: Record<string, unknown>) => {
      const created = await api(request, {
        method: 'POST',
        path: `/api/${collection}`,
        token,
        data,
      })
      expect(created.status).toBe(201)
      return created.body.doc.id as number
    }
    const remove = (collection: string, id: number) =>
      api(request, { method: 'DELETE', path: `/api/${collection}/${id}`, token })

    // Each node below is used in exactly one way, so each refusal names one check.
    const parent = await make('organizations', {
      name: `Parent ${tree.token}`,
      slug: uniqueSlug('parent'),
    })
    await make('organizations', {
      name: `Child ${tree.token}`,
      slug: uniqueSlug('child'),
      parent,
    })
    const assignedClass = await make('data-classes', {
      name: `Assigned ${tree.token}`,
      slug: uniqueSlug('assigned'),
    })
    await scopedUser(request, { dataClasses: [assignedClass] })
    const unused = await make('data-classes', {
      name: `Unused ${tree.token}`,
      slug: uniqueSlug('unused'),
    })

    expect(await remove('organizations', parent)).toMatchObject({ status: 400, message: inUse })
    expect(await remove('data-classes', assignedClass)).toMatchObject({
      status: 400,
      message: inUse,
    })
    expect(await remove('branches', tree.brA)).toMatchObject({ status: 400, message: inUse })
    expect((await remove('data-classes', unused)).status).toBe(200)

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
    expect(underChild).toMatchObject({ status: 400, message: cycle })
    expect(underItself).toMatchObject({ status: 400, message: cycle })
  })

  test('a repeated organization, branch or data class slug is a field error, not a 500', async ({
    request,
  }) => {
    const tree = await createScopeTree(request)
    const token = adminToken()
    const post = (collection: string, data: Record<string, unknown>) =>
      api(request, { method: 'POST', path: `/api/${collection}`, token, data })
    const patch = (collection: string, id: number, data: Record<string, unknown>) =>
      api(request, { method: 'PATCH', path: `/api/${collection}/${id}`, token, data })
    const slugError = (result: Awaited<ReturnType<typeof post>>) =>
      result.body.errors[0].data.errors.find((error: { path: string }) => error.path === 'slug')
        ?.message

    const cases = [
      { collection: 'organizations', subject: 'An organization', extra: {} },
      { collection: 'branches', subject: 'A branch', extra: { organization: tree.orgA } },
      { collection: 'data-classes', subject: 'A data class', extra: {} },
    ]
    for (const { collection, subject, extra } of cases) {
      const slug = uniqueSlug('dup')
      const first = await post(collection, { name: `First ${tree.token}`, slug, ...extra })
      expect(first.status, collection).toBe(201)

      const second = await post(collection, { name: `Second ${tree.token}`, slug, ...extra })
      expect(second.status, collection).toBe(400)
      expect(slugError(second), collection).toBe(`${subject} with this slug already exists.`)

      // Saving a row under its own slug is not a clash; taking another row's slug is.
      const other = await post(collection, {
        name: `Other ${tree.token}`,
        slug: uniqueSlug('other'),
        ...extra,
      })
      expect(other.status, collection).toBe(201)
      expect((await patch(collection, other.body.doc.id, { name: 'Renamed' })).status).toBe(200)
      const taken = await patch(collection, other.body.doc.id, { slug })
      expect(taken.status, collection).toBe(400)
      expect(slugError(taken), collection).toBe(`${subject} with this slug already exists.`)
    }
  })
})
