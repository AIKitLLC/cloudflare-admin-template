import { expect, test, type Page } from '@playwright/test'

import { adminStorageState } from '../../playwright.config'
import {
  createRole,
  ensureOwner,
  setGrant,
  signInToken,
  superAdminRoleId,
  uniqueSlug,
} from './helpers/access'
import { api } from './helpers/api'
import { uploadMedia } from './helpers/media'
import { adminToken, createUser, signInThroughUi, uniqueEmail, uniqueIp } from './helpers/sign-in'

const PASSWORD = 'e2e-role-user-password-123'
const DENIED = 'You are not allowed to perform this action.'
const OWNER_ONLY = 'Only a client security owner may perform this operation.'
const FINAL_OWNER = 'The final client security owner cannot be removed or demoted.'

const MEDIA_WRITE_FIELDS = ['alt', 'filename', 'mimeType', 'filesize', 'url'].map(
  (field) => `media:writeField:${field}`,
)

/** A role with the given keys and a user holding it, signed in over the API. */
async function userWithRole(
  request: Parameters<typeof createRole>[0],
  keys: string[],
): Promise<{
  email: string
  password: string
  id: number
  roleId: number
  token: string
  roleName: string
}> {
  const roleName = `Role ${uniqueSlug('r')}`
  const roleId = await createRole(request, { name: roleName, keys })
  const email = uniqueEmail('rbac')
  const id = await createUser(request, { email, password: PASSWORD, roles: [roleId] })
  const token = await signInToken(request, { email, password: PASSWORD })
  return { email, password: PASSWORD, id, roleId, token, roleName }
}

/** The collection and tool links the admin navigation shows. */
async function navLinks(page: Page): Promise<string[]> {
  const hrefs = await page
    .locator('nav a, aside a')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''))
  return hrefs
    .filter((href) =>
      /^\/admin\/(collections\/|permission-matrix|job-monitor|client-security)/.test(href),
    )
    .sort()
}

// The API cases pass explicit tokens, so no session cookie is needed. Screens that need the shared
// admin say so.
test.use({ storageState: { cookies: [], origins: [] } })

test.describe('What a role grants', () => {
  test('a role grants exactly what it names', async ({ request }) => {
    const user = await userWithRole(request, ['media:read'])

    expect(
      (await api(request, { method: 'GET', path: '/api/media', token: user.token })).status,
    ).toBe(200)
    const roles = await api(request, { method: 'GET', path: '/api/roles', token: user.token })
    expect(roles).toMatchObject({ status: 403, message: DENIED })
    const create = await api(request, {
      method: 'POST',
      path: '/api/users',
      token: user.token,
      data: { email: uniqueEmail('nope'), password: PASSWORD },
    })
    expect(create).toMatchObject({ status: 403, message: DENIED })
  })

  test('a signed-in user without a grant is refused where an anonymous visitor is not', async ({
    request,
  }) => {
    const user = await userWithRole(request, [])

    const anonymous = await api(request, { method: 'GET', path: '/api/media' })
    expect(anonymous.status).toBe(200)
    const signedIn = await api(request, { method: 'GET', path: '/api/media', token: user.token })
    expect(signedIn).toMatchObject({ status: 403, message: DENIED })
  })

  test('a user without a users grant sees only their own account', async ({ request }) => {
    const user = await userWithRole(request, [])

    const list = await api(request, {
      method: 'GET',
      path: '/api/users?limit=50',
      token: user.token,
    })

    expect(list.status).toBe(200)
    expect(list.body.docs.map((doc: { email: string }) => doc.email)).toEqual([user.email])
  })

  test('a user cannot change their own roles', async ({ request }) => {
    const user = await userWithRole(request, [])
    const superAdmin = await superAdminRoleId(request)

    const attempt = await api(request, {
      method: 'PATCH',
      path: `/api/users/${user.id}`,
      token: user.token,
      data: { roles: [superAdmin] },
    })

    expect(attempt.status).toBe(200)
    const stored = await api(request, {
      method: 'GET',
      path: `/api/users/${user.id}?depth=0`,
      token: adminToken(),
    })
    expect(stored.body.roles).toEqual([user.roleId])
  })

  test('a grant in the matrix takes effect at once and revoking ends it', async ({ request }) => {
    const user = await userWithRole(request, ['media:read'])
    const read = () => api(request, { method: 'GET', path: '/api/media', token: user.token })

    expect((await read()).status).toBe(200)
    expect(
      await setGrant(request, { roleId: user.roleId, key: 'media:read', granted: false }),
    ).toBe(200)
    expect((await read()).status).toBe(403)
    expect(await setGrant(request, { roleId: user.roleId, key: 'media:read', granted: true })).toBe(
      200,
    )
    expect((await read()).status).toBe(200)
  })

  test('a create grant needs the field grants too', async ({ request }) => {
    const user = await userWithRole(request, ['media:read', 'media:create'])

    const without = await uploadMedia(request, { token: user.token, alt: 'a pixel' })
    expect(without.status).toBe(400)
    expect(without.body.errors[0].data.errors[0].path).toBe('alt')

    for (const key of MEDIA_WRITE_FIELDS) {
      expect(await setGrant(request, { roleId: user.roleId, key, granted: true })).toBe(200)
    }
    const withFields = await uploadMedia(request, { token: user.token, alt: 'a pixel' })
    expect(withFields.status).toBe(201)
  })
})

test.describe('The client security role', () => {
  test('only an owner changes it', async ({ request }) => {
    const owner = await ensureOwner(request)
    const target = await userWithRole(request, [])
    const stored = async () =>
      (
        await api(request, {
          method: 'GET',
          path: `/api/users/${target.id}?depth=0`,
          token: adminToken(),
        })
      ).body.role

    const byAdmin = await api(request, {
      method: 'PATCH',
      path: `/api/users/${target.id}`,
      token: adminToken(),
      data: { role: 'editor' },
    })
    expect(byAdmin).toMatchObject({ status: 403, message: OWNER_ONLY })
    const sneaky = await api(request, {
      method: 'POST',
      path: '/api/users',
      token: adminToken(),
      data: { email: uniqueEmail('sneaky'), password: PASSWORD, role: 'owner' },
    })
    expect(sneaky).toMatchObject({ status: 403, message: OWNER_ONLY })
    expect(await stored()).toBe('admin')

    const ownerToken = await signInToken(request, owner)
    const byOwner = await api(request, {
      method: 'PATCH',
      path: `/api/users/${target.id}`,
      token: ownerToken,
      data: { role: 'editor' },
    })
    expect(byOwner.status).toBe(200)
    expect(await stored()).toBe('editor')
  })

  test('the only owner cannot be demoted', async ({ request }) => {
    const owner = await ensureOwner(request)
    const ownerToken = await signInToken(request, owner)

    const demote = await api(request, {
      method: 'PATCH',
      path: `/api/users/${owner.id}`,
      token: ownerToken,
      data: { role: 'admin' },
    })

    expect(demote).toMatchObject({ status: 409, message: FINAL_OWNER })
  })
})

test.describe('The admin screens per role', () => {
  test("a limited user's admin shows only what they may open", async ({ page, request }) => {
    const user = await userWithRole(request, ['media:read', 'media:create', ...MEDIA_WRITE_FIELDS])
    await signInThroughUi(page, { email: user.email, password: user.password, ip: uniqueIp() })
    await expect(page).toHaveURL(/\/admin\/?$/)

    await expect
      .poll(() => navLinks(page))
      .toEqual(['/admin/collections/media', '/admin/collections/users'])

    const roles = await page.goto('/admin/collections/roles')
    expect(roles?.status()).toBe(404)
    await expect(page.locator('body')).toContainText('Nothing found')

    await page.goto('/admin/collections/users/create')
    await expect(page.locator('body')).toContainText('You are not allowed to access this page.')

    await page.goto('/admin/permission-matrix')
    await expect(page.locator('body')).toContainText(
      'You need permission to read role permissions before this matrix is available.',
    )

    await page.goto('/admin/client-security')
    await expect(page.locator('body')).toContainText(
      'Only an authenticated owner can view or change client security settings.',
    )
  })

  test('toggling a matrix checkbox changes what that user can open', async ({
    browser,
    request,
  }) => {
    const user = await userWithRole(request, ['media:read'])
    const label = (
      await api(request, {
        method: 'GET',
        path: '/api/permissions?where[key][equals]=roles:read&depth=0',
        token: adminToken(),
      })
    ).body.docs[0].label as string

    const limited = await browser.newPage()
    await signInThroughUi(limited, { email: user.email, password: user.password, ip: uniqueIp() })
    await expect.poll(() => navLinks(limited)).not.toContain('/admin/collections/roles')

    const adminContext = await browser.newContext({ storageState: adminStorageState })
    const admin = await adminContext.newPage()
    await admin.goto('/admin/permission-matrix')
    const checkbox = admin.getByRole('checkbox', { name: `${user.roleName} ${label}`, exact: true })
    await expect(checkbox).toBeVisible()
    const [response] = await Promise.all([
      admin.waitForResponse((r) => r.url().endsWith('/api/rbac/grants')),
      checkbox.check(),
    ])
    expect(response.status()).toBe(200)
    await adminContext.close()

    await limited.reload()
    await expect.poll(() => navLinks(limited)).toContain('/admin/collections/roles')
    await limited.close()
  })

  test.describe('as the shared admin', () => {
    test.use({ storageState: adminStorageState })

    test('a Super Admin sees every collection and the matrix', async ({ page }) => {
      await page.goto('/admin')
      for (const href of [
        '/admin/collections/users',
        '/admin/collections/roles',
        '/admin/collections/permissions',
        '/admin/collections/role-permissions',
        '/admin/collections/audit-logs',
        '/admin/permission-matrix',
      ]) {
        await expect(
          page.locator(`nav a[href="${href}"], aside a[href="${href}"]`).first(),
        ).toBeVisible()
      }
    })

    test('a Super Admin who is not the owner cannot open client security', async ({ page }) => {
      await page.goto('/admin/client-security')

      await expect(page.locator('body')).toContainText(
        'Only an authenticated owner can view or change client security settings.',
      )
    })
  })
})
