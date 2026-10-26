import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import {
  attemptSignIn,
  createUser,
  signInThroughUi,
  uniqueEmail,
  uniqueIp,
} from './helpers/sign-in'

const WRONG_CREDENTIALS = 'The email or password provided is incorrect.'
const THROTTLED = 'Too many attempts. Try again later.'
const PASSWORD = 'sign-in-password-123'

// Every attempt that can fail uses its own IP and its own email, so a retry, a lockout or a
// throttle here never spends the shared 127.0.0.1 counter or touches `e2eAdmin`.
test.describe('Sign-in', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  async function newUser(request: APIRequestContext, prefix: string) {
    const user = { email: uniqueEmail(prefix), password: PASSWORD }
    await createUser(request, user)
    return user
  }

  /** From the page, so it uses the browser's cookie jar (the session cookie is Secure). */
  async function currentEmail(page: Page): Promise<string | null> {
    return page.evaluate(async () => {
      const me = await fetch('/api/users/me')
      const body = (await me.json()) as { user: { email: string } | null }
      return body.user?.email ?? null
    })
  }

  test('signs in and stays signed in after a reload', async ({ page, request }) => {
    const user = await newUser(request, 'signin')
    await signInThroughUi(page, { ...user, ip: uniqueIp() })

    await page.waitForURL(/\/admin$/)
    await expect(page.locator('span[title="Dashboard"]').first()).toBeVisible()
    expect(await currentEmail(page)).toBe(user.email)

    await page.reload()
    expect(await currentEmail(page)).toBe(user.email)
  })

  test('signs out and loses the session', async ({ page, request }) => {
    const user = await newUser(request, 'signout')
    await signInThroughUi(page, { ...user, ip: uniqueIp() })
    await page.waitForURL(/\/admin$/)

    await page.goto('/admin/logout')
    await page.waitForLoadState('networkidle')

    expect(await currentEmail(page)).toBeNull()
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/login/)
  })

  test('refuses a wrong password', async ({ page, request }) => {
    const user = await newUser(request, 'wrongpw')
    await signInThroughUi(page, { email: user.email, password: 'not-the-password-1', ip: uniqueIp() })

    await expect(page.getByText(WRONG_CREDENTIALS).first()).toBeVisible()
    await expect(page).toHaveURL(/\/admin\/login/)
    expect(await currentEmail(page)).toBeNull()
  })

  test('answers an unknown email exactly like a wrong password', async ({ page }) => {
    await signInThroughUi(page, {
      email: uniqueEmail('ghost'),
      password: 'not-the-password-1',
      ip: uniqueIp(),
    })

    await expect(page.getByText(WRONG_CREDENTIALS).first()).toBeVisible()
    await expect(page).toHaveURL(/\/admin\/login/)
  })

  test('treats a garbage session cookie as signed out', async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: 'payload-token', value: 'not.a.token', url: baseURL! }])

    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/login/)
    expect(await currentEmail(page)).toBeNull()
  })

  test('treats a tampered session as signed out', async ({ page, request, baseURL }) => {
    const user = await newUser(request, 'tamper')
    const { token } = await attemptSignIn(request, { ...user, ip: uniqueIp() })
    expect(token).toBeTruthy()

    // Control: the same cookie, untouched, signs this browser in, so the injection works.
    await page.context().addCookies([{ name: 'payload-token', value: token!, url: baseURL! }])
    await page.goto('/admin')
    await expect(page.locator('span[title="Dashboard"]').first()).toBeVisible()
    expect(await currentEmail(page)).toBe(user.email)

    await page.context().addCookies([{ name: 'payload-token', value: `${token}x`, url: baseURL! }])
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/login/)
    expect(await currentEmail(page)).toBeNull()
  })

  test('a token no longer works after the user signs out', async ({ request }) => {
    const user = await newUser(request, 'revoked')
    const { token } = await attemptSignIn(request, { ...user, ip: uniqueIp() })
    const headers = { authorization: `JWT ${token}` }
    const before = (await (await request.get('/api/users/me', { headers })).json()) as {
      user: { email: string } | null
    }
    expect(before.user?.email).toBe(user.email)

    const logout = await request.post('/api/users/logout', { headers })
    expect(logout.status()).toBe(200)

    const after = (await (await request.get('/api/users/me', { headers })).json()) as {
      user: { email: string } | null
    }
    expect(after.user).toBeNull()
  })

  test('locks an account after five failed sign-ins', async ({ page, request }) => {
    const user = await newUser(request, 'locked')
    // Each attempt comes from its own address, so the per-IP limit cannot be the cause.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failed = await attemptSignIn(request, {
        email: user.email,
        password: 'not-the-password-1',
        ip: uniqueIp(),
      })
      expect(failed.status, `failed attempt ${attempt}`).toBe(401)
      if (attempt < 5) expect(failed.message).toBe(WRONG_CREDENTIALS)
    }

    // Even the correct password is refused while the account is locked.
    const locked = await attemptSignIn(request, { ...user, ip: uniqueIp() })
    expect(locked.status).toBe(401)
    expect(locked.message).toMatch(/locked due to having too many failed login attempts/i)

    await signInThroughUi(page, { ...user, ip: uniqueIp() })
    await expect(
      page.getByText(/locked due to having too many failed login attempts/i).first(),
    ).toBeVisible()
    await expect(page).toHaveURL(/\/admin\/login/)
    expect(await currentEmail(page)).toBeNull()
  })

  test('throttles one IP after ten failures and leaves other IPs alone', async ({
    page,
    request,
  }) => {
    const user = await newUser(request, 'throttled')
    const blockedIp = uniqueIp()
    const otherIp = uniqueIp()

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const failed = await attemptSignIn(request, {
        email: uniqueEmail('nobody'),
        password: 'not-the-password-1',
        ip: blockedIp,
      })
      expect(failed.status, `failed attempt ${attempt}`).toBe(401)
    }

    // The eleventh request from that address is refused even with the right password.
    const blocked = await attemptSignIn(request, { ...user, ip: blockedIp })
    expect(blocked.status).toBe(429)
    expect(blocked.message).toBe(THROTTLED)

    const elsewhere = await attemptSignIn(request, { ...user, ip: otherIp })
    expect(elsewhere.status).toBe(200)

    await signInThroughUi(page, { ...user, ip: blockedIp })
    await expect(page.getByText(THROTTLED).first()).toBeVisible()
    await expect(page).toHaveURL(/\/admin\/login/)
    expect(await currentEmail(page)).toBeNull()
  })

  test('does not count successful sign-ins against the IP limit', async ({ request }) => {
    const user = await newUser(request, 'repeat')
    const ip = uniqueIp()

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const signedIn = await attemptSignIn(request, { ...user, ip })
      expect(signedIn.status, `sign-in ${attempt}`).toBe(200)
    }
  })
})
