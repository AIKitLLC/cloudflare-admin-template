import { expect, test } from '@playwright/test'

import { e2eAdmin } from './helpers/admin'

test.describe('Frontend', () => {
  test.describe('signed out', () => {
    test.use({ storageState: { cookies: [], origins: [] } })

    test('can go on homepage', async ({ page }) => {
      await page.goto('/')

      await expect(page).toHaveTitle(/Payload Blank Template/)
      await expect(page.locator('h1').first()).toHaveText('Welcome to your new project.')
    })
  })

  test('greets a signed-in admin by email', async ({ page }) => {
    await page.goto('/')

    await expect(page.locator('h1').first()).toHaveText(`Welcome back, ${e2eAdmin.email}`)
  })
})
