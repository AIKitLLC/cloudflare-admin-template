import { expect, test, type Page } from '@playwright/test'

import { adminStorageState } from '../../playwright.config'
import { e2eAdmin } from './helpers/admin'

// Runs first, on the empty database `serve-worker.mjs` starts from. The tests depend on each
// other (the last one completes setup), and a retry would find the admin already created.
test.describe.configure({ mode: 'serial', retries: 0 })

const SETUP_API = '/api/users/first-register'

/** Payload renders the email input twice with the same id on this screen, so take the first. */
async function fillSetupForm(
  page: Page,
  { email, password, confirm }: { email: string; password: string; confirm: string },
) {
  await page.goto('/admin/create-first-user')
  // Submitting before React hydrates posts the form to the page itself and never reaches the API.
  await page.waitForLoadState('networkidle')
  await page.locator('#field-email').first().fill(email)
  await page.locator('#field-password').fill(password)
  await page.locator('#field-confirm-password').fill(confirm)
}

/** Submits and returns the setup API response. Fails if the form never calls the API. */
async function submitSetupForm(page: Page) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith(SETUP_API) && candidate.request().method() === 'POST',
    ),
    page.click('button[type="submit"]'),
  ])
  return response
}

test.describe('First-run admin setup', () => {
  test('sends a signed-out visitor to the create-first-user screen', async ({ page }) => {
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/create-first-user/)
    await expect(page.locator('#field-email').first()).toBeVisible()
    await expect(page.locator('#field-password')).toBeVisible()
    await expect(page.locator('#field-confirm-password')).toBeVisible()
  })

  test('refuses a password shorter than 12 characters', async ({ page }) => {
    await fillSetupForm(page, {
      email: e2eAdmin.email,
      password: 'short-pass',
      confirm: 'short-pass',
    })
    const response = await submitSetupForm(page)

    expect(response.status()).toBe(400)
    await expect(page).toHaveURL(/\/admin\/create-first-user/)
    // Setup did not complete, so the signed-out visitor still gets the setup screen.
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/create-first-user/)
  })

  test('refuses a confirmation that does not match', async ({ page }) => {
    await fillSetupForm(page, {
      email: e2eAdmin.email,
      password: e2eAdmin.password,
      confirm: `${e2eAdmin.password}-different`,
    })
    const calls: string[] = []
    page.on('request', (request) => {
      if (request.url().endsWith(SETUP_API)) calls.push(request.url())
    })
    await page.click('button[type="submit"]')

    // Payload's form rejects the mismatch itself, so nothing is sent.
    await expect(page.getByText(/match/i).first()).toBeVisible()
    expect(calls).toEqual([])
    await expect(page).toHaveURL(/\/admin\/create-first-user/)
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/create-first-user/)
  })

  test('creates the Super Admin and signs them in', async ({ page }) => {
    await fillSetupForm(page, {
      email: e2eAdmin.email,
      password: e2eAdmin.password,
      confirm: e2eAdmin.password,
    })
    const response = await submitSetupForm(page)

    expect(response.status()).toBe(200)
    await page.waitForURL(/\/admin$/)
    await expect(page.locator('span[title="Dashboard"]').first()).toBeVisible()

    // From the page, so it uses the browser's cookie jar like every later spec does. The admin
    // cookie is Secure, which Playwright's own request client does not send over http.
    const body = await page.evaluate(async () => {
      const me = await fetch('/api/users/me')
      return (await me.json()) as { user: { email: string } | null }
    })
    expect(body.user?.email).toBe(e2eAdmin.email)

    await page.context().storageState({ path: adminStorageState })
  })

  test('closes setup once an admin exists', async ({ browser, baseURL }) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.goto('/admin/create-first-user')
    await expect(page).not.toHaveURL(/\/admin\/create-first-user/)

    // The same-origin headers pass, so the 403 comes from the completed setup state.
    const response = await context.request.post('/api/users/first-register', {
      headers: { origin: baseURL! },
      data: {
        email: 'late-admin@example.com',
        password: e2eAdmin.password,
        'confirm-password': e2eAdmin.password,
      },
    })
    expect(response.status()).toBe(403)

    await context.close()
  })
})
