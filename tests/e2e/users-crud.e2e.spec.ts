import { expect, test, type Page, type Response } from '@playwright/test'

import { superAdminRoleId, userWithRole } from './helpers/access'
import { api } from './helpers/api'
import { adminToken, attemptSignIn, createUser, uniqueEmail, uniqueIp } from './helpers/sign-in'

const PASSWORD = 'e2e-crud-user-password-123'
const DUPLICATE = 'A user with the given email is already registered.'
// Payload shows the field error and a toast; a later form-state answer can clear the field error,
// so either text proves the refusal reached the screen.
const SHOWN_DUPLICATE =
  /A user with the given email is already registered\.|The following field is invalid: email/

const isUsersPost = (r: Response) =>
  new URL(r.url()).pathname === '/api/users' && r.request().method() === 'POST'

/** Fills the create-user screen and saves. Returns the response of the create request. */
async function createThroughScreen(
  page: Page,
  { email, password }: { email: string; password: string },
): Promise<Response> {
  await page.goto('/admin/collections/users/create', { waitUntil: 'domcontentloaded' })
  // Payload sets this once the form is hydrated; typing earlier is lost on hydration.
  await page.waitForSelector('form[data-form-ready="true"]')
  await page.fill('#field-email', email)
  await page.fill('#field-password', password)
  await page.fill('#field-confirm-password', password)
  const [response] = await Promise.all([
    page.waitForResponse(isUsersPost),
    page.click('#action-save'),
  ])
  return response
}

async function usersWithEmail(request: Parameters<typeof api>[0], email: string): Promise<number> {
  const { body } = await api(request, {
    method: 'GET',
    path: `/api/users?where[email][equals]=${encodeURIComponent(email)}&depth=0`,
    token: adminToken(),
  })
  return body.totalDocs
}

test.describe('Users through the admin screens', () => {
  test('creates a user from the create screen', async ({ page, request }) => {
    const email = uniqueEmail('created')

    const response = await createThroughScreen(page, { email, password: PASSWORD })

    expect(response.status()).toBe(201)
    const id = ((await response.json()) as { doc: { id: number } }).doc.id
    await expect(page).toHaveURL(new RegExp(`/admin/collections/users/${id}$`))
    const signIn = await attemptSignIn(request, { email, password: PASSWORD, ip: uniqueIp() })
    expect(signIn.status).toBe(200)
  })

  test('refuses a duplicate email on the screen', async ({ page, request }) => {
    const email = uniqueEmail('duplicate')
    await createUser(request, { email, password: PASSWORD })

    const response = await createThroughScreen(page, { email, password: PASSWORD })

    expect(response.status()).toBe(400)
    await expect(page.getByText(SHOWN_DUPLICATE).first()).toBeVisible()
    expect(await usersWithEmail(request, email)).toBe(1)
  })

  test('refuses a duplicate email in another case, an invalid email and a missing password', async ({
    request,
  }) => {
    const email = uniqueEmail('case')
    await createUser(request, { email, password: PASSWORD })
    const create = (data: Record<string, string>) =>
      api(request, { method: 'POST', path: '/api/users', token: adminToken(), data })
    const firstError = (body: {
      errors: { data: { errors: { message: string; path: string }[] } }[]
    }) => body.errors[0].data.errors[0]

    const sameAddress = await create({ email: email.toUpperCase(), password: PASSWORD })
    const invalid = await create({ email: 'not-an-email', password: PASSWORD })
    const noPassword = await create({ email: uniqueEmail('nopw') })

    expect(sameAddress.status).toBe(400)
    expect(firstError(sameAddress.body)).toMatchObject({ path: 'email', message: DUPLICATE })
    expect(invalid.status).toBe(400)
    expect(firstError(invalid.body)).toMatchObject({
      path: 'email',
      message: 'Please enter a valid email address.',
    })
    expect(noPassword.status).toBe(400)
    expect(firstError(noPassword.body)).toMatchObject({
      path: 'password',
      message: 'This field is required.',
    })
    expect(await usersWithEmail(request, email)).toBe(1)
  })

  test("edits a user's email from the edit screen", async ({ page, request }) => {
    const email = uniqueEmail('before')
    const renamed = uniqueEmail('after')
    const id = await createUser(request, { email, password: PASSWORD })

    await page.goto(`/admin/collections/users/${id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('form[data-form-ready="true"]')
    await page.fill('#field-email', renamed)
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => new URL(r.url()).pathname === `/api/users/${id}` && r.request().method() === 'PATCH',
      ),
      page.click('#action-save'),
    ])

    expect(response.status()).toBe(200)
    const signIn = await attemptSignIn(request, {
      email: renamed,
      password: PASSWORD,
      ip: uniqueIp(),
    })
    expect(signIn.status).toBe(200)
  })

  test('deletes a user from the edit screen', async ({ page, request }) => {
    const email = uniqueEmail('doomed')
    const id = await createUser(request, { email, password: PASSWORD })

    await page.goto(`/admin/collections/users/${id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('form[data-form-ready="true"]')
    await page.locator('.doc-controls button.popup-button').first().click()
    await page.click('#action-delete')
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(`/api/users/${id}`) && r.request().method() === 'DELETE',
      ),
      page.click('#confirm-action'),
    ])

    expect(response.status()).toBe(200)
    const read = await api(request, {
      method: 'GET',
      path: `/api/users/${id}`,
      token: adminToken(),
    })
    expect(read.status).toBe(404)
    const signIn = await attemptSignIn(request, { email, password: PASSWORD, ip: uniqueIp() })
    expect(signIn.status).toBe(401)
  })

  test('a user with users:delete can delete themselves but not a Super Admin', async ({
    request,
  }) => {
    const superAdminId = await createUser(request, {
      email: uniqueEmail('super'),
      password: PASSWORD,
      roles: [await superAdminRoleId(request)],
    })
    const manager = await userWithRole(request, ['users:read', 'users:delete'])

    const superAdmin = await api(request, {
      method: 'DELETE',
      path: `/api/users/${superAdminId}`,
      token: manager.token,
    })
    expect(superAdmin).toMatchObject({
      status: 403,
      message: 'You are not allowed to perform this action.',
    })

    const self = await api(request, {
      method: 'DELETE',
      path: `/api/users/${manager.id}`,
      token: manager.token,
    })
    expect(self.status).toBe(200)
    const me = await api(request, { method: 'GET', path: '/api/users/me', token: manager.token })
    expect(me.body.user).toBeNull()
  })
})
