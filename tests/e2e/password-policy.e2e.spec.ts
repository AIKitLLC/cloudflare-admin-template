import { expect, test, type APIRequestContext } from '@playwright/test'

import { e2eAdmin } from './helpers/admin'
import { requestRecovery, resetPassword, storedResetToken } from './helpers/recovery'
import { attemptSignIn, createUser, uniqueEmail, uniqueIp } from './helpers/sign-in'

const OLD_PASSWORD = 'old-policy-password-1'
const LENGTH_MESSAGE = 'The password must be between 12 and 256 characters.'
const SHORT_PASSWORDS = ['abc', 'a'.repeat(11)]
const TWELVE = 'twelve-chars'

// Every request uses its own client address, so no per-IP throttle counter is shared.
test.describe('Password length policy', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  async function adminToken(request: APIRequestContext): Promise<string> {
    const signedIn = await attemptSignIn(request, { ...e2eAdmin, ip: uniqueIp() })
    expect(signedIn.status).toBe(200)
    return signedIn.token!
  }

  async function signsIn(request: APIRequestContext, email: string, password: string) {
    return (await attemptSignIn(request, { email, password, ip: uniqueIp() })).status
  }

  async function errorOf(response: Awaited<ReturnType<APIRequestContext['post']>>) {
    const body = (await response.json()) as { errors?: { message: string }[] }
    return { status: response.status(), message: body.errors?.[0]?.message ?? '' }
  }

  test('a reset with a short password is refused and leaves the token usable', async ({
    request,
  }) => {
    expect(TWELVE).toHaveLength(12)
    const user = { email: uniqueEmail('policy-reset'), password: OLD_PASSWORD }
    await createUser(request, user)
    await requestRecovery(request, { email: user.email, ip: uniqueIp() })
    const token = (await storedResetToken(user.email))!
    expect(token).toMatch(/^[a-f0-9]{40}$/)

    for (const password of SHORT_PASSWORDS) {
      const refused = await resetPassword(request, { token, password, ip: uniqueIp() })
      expect(refused, `${password.length} characters`).toMatchObject({
        status: 400,
        message: LENGTH_MESSAGE,
      })
      expect(refused.sessionToken).toBeUndefined()
      expect(await storedResetToken(user.email)).toBe(token)
      expect(await signsIn(request, user.email, OLD_PASSWORD)).toBe(200)
      expect(await signsIn(request, user.email, password)).toBe(401)
    }

    const accepted = await resetPassword(request, { token, password: TWELVE, ip: uniqueIp() })
    expect(accepted.status).toBe(200)
    expect(await signsIn(request, user.email, TWELVE)).toBe(200)
    expect(await signsIn(request, user.email, OLD_PASSWORD)).toBe(401)
  })

  test('creating a user with a short password is refused', async ({ request }) => {
    const token = await adminToken(request)
    for (const password of SHORT_PASSWORDS) {
      const email = uniqueEmail('policy-create')
      const refused = await request.post('/api/users', {
        headers: { authorization: `JWT ${token}` },
        data: { email, password },
      })
      expect(await errorOf(refused), `${password.length} characters`).toEqual({
        status: 400,
        message: LENGTH_MESSAGE,
      })
      expect(await signsIn(request, email, password)).toBe(401)
    }

    const email = uniqueEmail('policy-create')
    const created = await request.post('/api/users', {
      headers: { authorization: `JWT ${token}` },
      data: { email, password: TWELVE },
    })
    expect(created.status()).toBe(201)
    expect(await signsIn(request, email, TWELVE)).toBe(200)
  })

  test('changing a password by id or by query refuses a short one and keeps the old one', async ({
    request,
  }) => {
    const token = await adminToken(request)
    const headers = { authorization: `JWT ${token}` }
    const user = { email: uniqueEmail('policy-update'), password: OLD_PASSWORD }
    const created = await request.post('/api/users', { headers, data: user })
    expect(created.status()).toBe(201)
    const id = ((await created.json()) as { doc: { id: number } }).doc.id
    const byQuery = `/api/users?where[email][equals]=${encodeURIComponent(user.email)}`

    for (const password of SHORT_PASSWORDS) {
      for (const path of [`/api/users/${id}`, byQuery]) {
        const refused = await request.patch(path, { headers, data: { password } })
        expect(await errorOf(refused), `${path} with ${password.length} characters`).toEqual({
          status: 400,
          message: LENGTH_MESSAGE,
        })
      }
      expect(await signsIn(request, user.email, OLD_PASSWORD)).toBe(200)
      expect(await signsIn(request, user.email, password)).toBe(401)
    }

    const byId = await request.patch(`/api/users/${id}`, { headers, data: { password: TWELVE } })
    expect(byId.status()).toBe(200)
    expect(await signsIn(request, user.email, TWELVE)).toBe(200)
    expect(await signsIn(request, user.email, OLD_PASSWORD)).toBe(401)

    const queried = await request.patch(byQuery, {
      headers,
      data: { password: `${TWELVE}-again` },
    })
    expect(queried.status()).toBe(200)
    expect(await signsIn(request, user.email, `${TWELVE}-again`)).toBe(200)
  })
})
