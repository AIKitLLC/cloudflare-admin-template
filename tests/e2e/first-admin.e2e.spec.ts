import { expect, test } from '@playwright/test'

import { adminStorageState } from '../../playwright.config'
import { e2eAdmin } from './helpers/admin'

// Runs first, on the empty database `serve-worker.mjs` starts from. The tests depend on each
// other (the last one completes setup), and a retry would find the admin already created.
test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('First-run admin setup', () => {
  test('sends a signed-out visitor to the create-first-user screen', async ({ page }) => {
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/create-first-user/)
    await expect(page.locator('#field-email')).toBeVisible()
    await expect(page.locator('#field-password')).toBeVisible()
    await expect(page.locator('#field-confirm-password')).toBeVisible()
  })

  test('refuses a password shorter than 12 characters', async ({ page }) => {
    await page.goto('/admin/create-first-user')
    await page.fill('#field-email', e2eAdmin.email)
    await page.fill('#field-password', 'short-pass')
    await page.fill('#field-confirm-password', 'short-pass')
    await page.click('button[type="submit"]')

    await expect(page).toHaveURL(/\/admin\/create-first-user/)
    // Setup did not complete, so the signed-out visitor still gets the setup screen.
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/create-first-user/)
  })

  test('refuses a confirmation that does not match', async ({ page }) => {
    await page.goto('/admin/create-first-user')
    await page.fill('#field-email', e2eAdmin.email)
    await page.fill('#field-password', e2eAdmin.password)
    await page.fill('#field-confirm-password', `${e2eAdmin.password}-different`)
    await page.click('button[type="submit"]')

    await expect(page).toHaveURL(/\/admin\/create-first-user/)
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/create-first-user/)
  })

  test('creates the Super Admin and signs them in', async ({ page }) => {
    await page.goto('/admin/create-first-user')
    await page.fill('#field-email', e2eAdmin.email)
    await page.fill('#field-password', e2eAdmin.password)
    await page.fill('#field-confirm-password', e2eAdmin.password)
    await page.click('button[type="submit"]')

    await page.waitForURL(/\/admin$/)
    await expect(page.locator('span[title="Dashboard"]').first()).toBeVisible()

    const me = await page.request.get('/api/users/me')
    const body = (await me.json()) as { user: { email: string } | null }
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
