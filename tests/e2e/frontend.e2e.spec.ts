import { expect, test } from '@playwright/test'

import { e2eAdmin } from './helpers/admin'
import { createUser, currentEmail, signInThroughUi, uniqueEmail, uniqueIp } from './helpers/sign-in'

const PASSWORD = 'frontend-user-password-123'

test.describe('Frontend', () => {
  test.describe('signed out', () => {
    test.use({ storageState: { cookies: [], origins: [] } })

    test('can go on homepage', async ({ page }) => {
      await page.goto('/')

      await expect(page).toHaveTitle(/Payload Blank Template/)
      await expect(page.locator('h1').first()).toHaveText('Welcome to your new project.')
    })
  })

  test.describe('signed out, links', () => {
    test.use({ storageState: { cookies: [], origins: [] } })

    test('links to the admin panel and the docs', async ({ page }) => {
      await page.goto('/')

      const admin = page.locator('a.admin')
      const docs = page.locator('a.docs')
      await expect(admin).toHaveAttribute('href', '/admin')
      await expect(docs).toHaveAttribute('href', 'https://payloadcms.com/docs')
      for (const link of [admin, docs]) {
        await expect(link).toHaveAttribute('target', '_blank')
        await expect(link).toHaveAttribute('rel', /noopener/)
      }
    })
  })

  test.describe('another user', () => {
    test.use({ storageState: { cookies: [], origins: [] } })

    test('a signed-in user without roles still sees the greeting', async ({ page, request }) => {
      const user = { email: uniqueEmail('frontend'), password: PASSWORD }
      await createUser(request, user)

      await signInThroughUi(page, { ...user, ip: uniqueIp() })
      await page.waitForURL(/\/admin\/?$/)
      await page.goto('/')

      await expect(page.locator('h1').first()).toHaveText(`Welcome back, ${user.email}`)
    })

    test('shows the signed-out page again after signing out', async ({ page, request }) => {
      const user = { email: uniqueEmail('frontend'), password: PASSWORD }
      await createUser(request, user)
      await signInThroughUi(page, { ...user, ip: uniqueIp() })
      await page.waitForURL(/\/admin\/?$/)

      await page.goto('/admin/logout')
      await expect(page).toHaveURL(/\/admin\/login/)
      expect(await currentEmail(page)).toBeNull()
      await page.goto('/')

      await expect(page.locator('h1').first()).toHaveText('Welcome to your new project.')
    })
  })

  test('greets a signed-in admin by email', async ({ page }) => {
    await page.goto('/')

    await expect(page.locator('h1').first()).toHaveText(`Welcome back, ${e2eAdmin.email}`)
  })
})
