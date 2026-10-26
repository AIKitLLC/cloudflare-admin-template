import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test'

import {
  expireResetToken,
  requestRecovery,
  resetPassword,
  storedResetToken,
} from './helpers/recovery'
import { e2eAdmin } from './helpers/admin'
import { attemptSignIn, createUser, currentEmail, uniqueEmail, uniqueIp } from './helpers/sign-in'

const INVALID_TOKEN = 'Token is either invalid or has expired.'
const OLD_PASSWORD = 'old-recovery-password-1'
const NEW_PASSWORD = 'new-recovery-password-1'
const TOKEN_SHAPE = /^[a-f0-9]{40}$/
const THROTTLED = 'Too many attempts. Try again later.'
const NOT_A_SUBSET =
  'You can only update or delete a user whose permissions are a subset of your own.'
const OUTSIDE_SCOPE = 'You can only change a user inside your scope.'

// One user and one client address per test. Payload will not issue a second token for the
// same user right after a reset, so no test recovers the same account twice.
test.describe('Password recovery', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  async function newUser(request: APIRequestContext, prefix: string) {
    const user = { email: uniqueEmail(prefix), password: OLD_PASSWORD }
    await createUser(request, user)
    return user
  }

  /** Opens a Payload form screen from `ip` and waits until the form is mounted and usable. */
  async function openFormScreen(page: Page, path: string, ip: string) {
    await page.context().setExtraHTTPHeaders({ 'cf-connecting-ip': ip })
    await page.goto(path)
    await page.locator('form[data-form-ready="true"]').waitFor()
  }

  /**
   * Submits the reset form and returns the reset-password response. Payload refuses a submit made
   * within about half a second of the last keystroke ("Please correct invalid fields." and no
   * request), every time and not occasionally, so the click is repeated until the request goes out.
   */
  async function submitResetForm(page: Page): Promise<Response> {
    let response: Response | undefined
    await expect(async () => {
      const [sent] = await Promise.all([
        page.waitForResponse((candidate) => candidate.url().endsWith('/api/users/reset-password'), {
          timeout: 2000,
        }),
        page.click('button[type="submit"]'),
      ])
      response = sent
    }).toPass({ timeout: 15_000 })
    return response!
  }

  test('answers a known and an unknown email identically', async ({ request }) => {
    const user = await newUser(request, 'forgot')
    const stranger = uniqueEmail('ghost')

    const known = await requestRecovery(request, { email: user.email, ip: uniqueIp() })
    const unknown = await requestRecovery(request, { email: stranger, ip: uniqueIp() })

    expect(known).toEqual({ status: 200, message: 'Success' })
    expect(unknown).toEqual(known)
    expect(await storedResetToken(user.email)).toMatch(TOKEN_SHAPE)
    expect(await storedResetToken(stranger)).toBeNull()
  })

  test('refuses a request without an email', async ({ request }) => {
    const response = await request.post('/api/users/forgot-password', {
      headers: { 'cf-connecting-ip': uniqueIp() },
      data: {},
    })

    expect(response.status()).toBe(400)
    expect(await response.text()).toContain('Missing email.')
  })

  test('recovers an account through the admin screens', async ({ page, request }) => {
    const user = await newUser(request, 'recover')
    const ip = uniqueIp()

    await openFormScreen(page, '/admin/forgot', ip)
    await page.locator('#field-email').first().fill(user.email)
    const [forgot] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/users/forgot-password')),
      page.click('button[type="submit"]'),
    ])
    expect(forgot.status()).toBe(200)
    await expect(page.getByText(/email sent|instructions to reset/i).first()).toBeVisible()

    const token = await storedResetToken(user.email)
    expect(token).toMatch(TOKEN_SHAPE)

    await openFormScreen(page, `/admin/reset/${token}`, ip)
    await page.locator('#field-password').fill(NEW_PASSWORD)
    await page.locator('#field-confirm-password').fill(NEW_PASSWORD)
    const reset = await submitResetForm(page)
    expect(reset.status()).toBe(200)

    await page.waitForURL(/\/admin$/)
    expect(await currentEmail(page)).toBe(user.email)

    const oldPassword = await attemptSignIn(request, { ...user, ip: uniqueIp() })
    expect(oldPassword.status).toBe(401)
    const newPassword = await attemptSignIn(request, {
      email: user.email,
      password: NEW_PASSWORD,
      ip: uniqueIp(),
    })
    expect(newPassword.status).toBe(200)
  })

  test('refuses a confirmation that does not match on the reset screen', async ({
    page,
    request,
  }) => {
    const user = await newUser(request, 'mismatch')
    const ip = uniqueIp()
    await requestRecovery(request, { email: user.email, ip })
    const token = await storedResetToken(user.email)
    expect(token).toMatch(TOKEN_SHAPE)

    await openFormScreen(page, `/admin/reset/${token}`, ip)
    const sent: string[] = []
    page.on('request', (outgoing) => {
      if (outgoing.url().endsWith('/api/users/reset-password')) sent.push(outgoing.url())
    })
    await page.locator('#field-password').fill(NEW_PASSWORD)
    await page.locator('#field-confirm-password').fill(`${NEW_PASSWORD}-different`)
    await page.click('button[type="submit"]')

    // Payload's form rejects the mismatch itself, so nothing is sent and the token stays usable.
    await expect(page.getByText(/match/i).first()).toBeVisible()
    expect(sent).toEqual([])
    expect(await storedResetToken(user.email)).toBe(token)
  })

  test('rejects an unknown, a reused and an expired token the same way', async ({ request }) => {
    const user = await newUser(request, 'tokens')
    await requestRecovery(request, { email: user.email, ip: uniqueIp() })
    const token = (await storedResetToken(user.email))!
    expect(token).toMatch(TOKEN_SHAPE)
    const first = await resetPassword(request, {
      token,
      password: NEW_PASSWORD,
      ip: uniqueIp(),
    })
    expect(first.status).toBe(200)

    const reused = await resetPassword(request, {
      token,
      password: 'another-recovery-password-1',
      ip: uniqueIp(),
    })
    const unknown = await resetPassword(request, {
      token: '0'.repeat(40),
      password: NEW_PASSWORD,
      ip: uniqueIp(),
    })

    const late = await newUser(request, 'expired')
    await requestRecovery(request, { email: late.email, ip: uniqueIp() })
    const lateToken = (await storedResetToken(late.email))!
    expect(lateToken).toMatch(TOKEN_SHAPE)
    await expireResetToken(late.email)
    const expired = await resetPassword(request, {
      token: lateToken,
      password: NEW_PASSWORD,
      ip: uniqueIp(),
    })

    const refused = {
      status: 403,
      message: INVALID_TOKEN,
      sessionToken: undefined as string | undefined,
    }
    expect(reused).toEqual(refused)
    expect(unknown).toEqual(refused)
    expect(expired).toEqual(refused)

    // The expired attempt changed nothing: the old password still works.
    const stillOld = await attemptSignIn(request, { ...late, ip: uniqueIp() })
    expect(stillOld.status).toBe(200)
  })

  test('a reset unlocks a locked account', async ({ request }) => {
    const user = await newUser(request, 'unlock')
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failed = await attemptSignIn(request, {
        email: user.email,
        password: 'not-the-password-1',
        ip: uniqueIp(),
      })
      expect(failed.status, `failed attempt ${attempt}`).toBe(401)
    }
    const locked = await attemptSignIn(request, { ...user, ip: uniqueIp() })
    expect(locked.message).toMatch(/locked due to having too many failed login attempts/i)

    await requestRecovery(request, { email: user.email, ip: uniqueIp() })
    const token = (await storedResetToken(user.email))!
    expect(token).toMatch(TOKEN_SHAPE)
    const reset = await resetPassword(request, { token, password: NEW_PASSWORD, ip: uniqueIp() })
    expect(reset.status).toBe(200)

    const signedIn = await attemptSignIn(request, {
      email: user.email,
      password: NEW_PASSWORD,
      ip: uniqueIp(),
    })
    expect(signedIn.status).toBe(200)
  })

  test('a reset ends sessions issued before it', async ({ request }) => {
    const user = await newUser(request, 'sessions')
    const { token: session } = await attemptSignIn(request, { ...user, ip: uniqueIp() })
    const headers = { authorization: `JWT ${session}` }
    const me = async () =>
      ((await (await request.get('/api/users/me', { headers })).json()) as {
        user: { email: string } | null
      }).user

    expect((await me())?.email).toBe(user.email)

    await requestRecovery(request, { email: user.email, ip: uniqueIp() })
    const token = (await storedResetToken(user.email))!
    expect(token).toMatch(TOKEN_SHAPE)
    const reset = await resetPassword(request, { token, password: NEW_PASSWORD, ip: uniqueIp() })
    expect(reset.status).toBe(200)

    expect(await me()).toBeNull()
  })

  test('a signed-in ordinary user cannot start recovery for the Super Admin', async ({
    request,
  }) => {
    const actor = await newUser(request, 'actor')
    const { token } = await attemptSignIn(request, { ...actor, ip: uniqueIp() })

    const refused = await requestRecovery(request, {
      email: e2eAdmin.email,
      ip: uniqueIp(),
      token,
    })

    expect(refused).toEqual({ status: 403, message: NOT_A_SUBSET })
    expect(await storedResetToken(e2eAdmin.email)).toBeNull()
  })

  test('a signed-in user cannot start recovery for a user outside their scope', async ({
    request,
  }) => {
    const actor = await newUser(request, 'scoped')
    const target = await newUser(request, 'target')
    const { token } = await attemptSignIn(request, { ...actor, ip: uniqueIp() })

    const refused = await requestRecovery(request, { email: target.email, ip: uniqueIp(), token })

    expect(refused).toEqual({ status: 403, message: OUTSIDE_SCOPE })
    expect(await storedResetToken(target.email)).toBeNull()
  })

  test('throttles forgot-password after five requests from one IP', async ({ request }) => {
    const blockedIp = uniqueIp()
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const allowed = await requestRecovery(request, { email: uniqueEmail('nobody'), ip: blockedIp })
      expect(allowed.status, `request ${attempt}`).toBe(200)
    }

    const sixth = await requestRecovery(request, { email: uniqueEmail('nobody'), ip: blockedIp })
    expect(sixth).toEqual({ status: 429, message: THROTTLED })

    const elsewhere = await requestRecovery(request, {
      email: uniqueEmail('nobody'),
      ip: uniqueIp(),
    })
    expect(elsewhere.status).toBe(200)
  })

  test('throttles reset-password after ten requests from one IP', async ({ request }) => {
    const blockedIp = uniqueIp()
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const refused = await resetPassword(request, {
        token: '1'.repeat(40),
        password: NEW_PASSWORD,
        ip: blockedIp,
      })
      expect(refused.status, `request ${attempt}`).toBe(403)
    }

    const eleventh = await resetPassword(request, {
      token: '1'.repeat(40),
      password: NEW_PASSWORD,
      ip: blockedIp,
    })
    expect({ status: eleventh.status, message: eleventh.message }).toEqual({
      status: 429,
      message: THROTTLED,
    })

    const elsewhere = await resetPassword(request, {
      token: '1'.repeat(40),
      password: NEW_PASSWORD,
      ip: uniqueIp(),
    })
    expect(elsewhere.status).toBe(403)
  })
})
