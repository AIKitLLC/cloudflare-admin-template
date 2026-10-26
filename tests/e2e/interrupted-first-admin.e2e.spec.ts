// Recovery of a first-run setup that died after creating the user. Runs against the second
// Worker (its own database, project `interrupted-setup`): the shared database already completed
// setup in the first-admin spec, and the web flow never reopens. Each case builds the state it
// needs with `sealedSetup` and `interruptSetup`, so the order of the cases does not matter. The
// 2-minute claim age is backdated in the database, never waited out.
import { expect, test } from '@playwright/test'

import { api } from './helpers/api'
import {
  interruptedAdmin,
  interruptSetup,
  LIVE_CLAIM_MS,
  register,
  sealedSetup,
  setupSnapshot,
  STALE_CLAIM_MS,
  STATE_DIR,
} from './helpers/interrupted-setup'
import { attemptSignIn, uniqueEmail, uniqueIp } from './helpers/sign-in'
import { withDatabase } from './helpers/database'

const DENIED = 'You are not allowed to perform this action.'
const WRONG_CREDENTIALS = 'The email or password provided is incorrect.'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request, baseURL }) => {
  await sealedSetup(request, baseURL!)
})

/** The state an attempt leaves when it dies after creating the user, asserted so a case cannot pass on a state it did not build. */
async function interrupted(claimAgeMs: number) {
  await interruptSetup({ claimAgeMs })
  expect(await setupSnapshot()).toEqual({
    claimToken: 'dead-attempt',
    completed: false,
    users: [interruptedAdmin.email],
    roleLinks: 0,
  })
}

test.describe('Interrupted first-admin setup', () => {
  test('setup stays closed after a normal setup', async ({ request, baseURL }) => {
    expect(await setupSnapshot()).toMatchObject({ completed: true, claimToken: null, roleLinks: 1 })

    const again = await register(request, interruptedAdmin, baseURL!)

    expect(again).toMatchObject({ status: 403, message: DENIED })
  })

  test('finishes setup for the one existing user', async ({ request, baseURL }) => {
    await interrupted(STALE_CLAIM_MS)

    const recovered = await register(request, interruptedAdmin, baseURL!)

    expect(recovered).toMatchObject({ status: 200, message: 'Successfully registered first user.' })
    expect(typeof recovered.body.token).toBe('string')
    expect(await setupSnapshot()).toEqual({
      claimToken: null,
      completed: true,
      users: [interruptedAdmin.email],
      roleLinks: 1,
    })
    const signIn = await attemptSignIn(request, { ...interruptedAdmin, ip: uniqueIp() })
    expect(signIn.status).toBe(200)
  })

  for (const [title, credentials] of [
    ['the wrong password', { ...interruptedAdmin, password: 'some-other-password-123' }],
    ['another email', { email: uniqueEmail('stranger'), password: interruptedAdmin.password }],
  ] as const) {
    test(`finishes setup even when the retry has ${title}, creating no account`, async ({
      request,
      baseURL,
    }) => {
      await interrupted(STALE_CLAIM_MS)

      const retry = await register(request, credentials, baseURL!)

      // The recovery runs before credentials are checked; sign in afterwards with the originals.
      expect(retry).toMatchObject({ status: 401, message: WRONG_CREDENTIALS })
      expect(await setupSnapshot()).toEqual({
        claimToken: null,
        completed: true,
        users: [interruptedAdmin.email],
        roleLinks: 1,
      })
      const signIn = await attemptSignIn(request, { ...interruptedAdmin, ip: uniqueIp() })
      expect(signIn.status).toBe(200)
    })
  }

  test('does not take over a live claim', async ({ request, baseURL }) => {
    await interrupted(LIVE_CLAIM_MS)

    const attempt = await register(request, interruptedAdmin, baseURL!)

    expect(attempt).toMatchObject({ status: 403, message: DENIED })
    // The claim is untouched and nobody is promoted. `completed` proves the request reached the
    // setup code (an origin refusal is the same 403): a refused web request seals setup, so after an
    // early retry only `pnpm admin:create` can finish it.
    expect(await setupSnapshot()).toMatchObject({
      claimToken: 'dead-attempt',
      completed: true,
      roleLinks: 0,
    })
  })

  test('never promotes anyone when two users exist', async ({ request, baseURL }) => {
    const admin = await attemptSignIn(request, { ...interruptedAdmin, ip: uniqueIp() })
    const second = uniqueEmail('second')
    const created = await api(request, {
      method: 'POST',
      path: '/api/users',
      token: admin.token,
      data: { email: second, password: 'second-user-password-123' },
    })
    expect(created.status).toBe(201)
    try {
      await interruptSetup({ claimAgeMs: STALE_CLAIM_MS })
      expect(await setupSnapshot()).toMatchObject({
        completed: false,
        users: [interruptedAdmin.email, second],
        roleLinks: 0,
      })

      const attempt = await register(request, interruptedAdmin, baseURL!)

      expect(attempt).toMatchObject({ status: 403, message: DENIED })
      expect(await setupSnapshot()).toMatchObject({
        users: [interruptedAdmin.email, second],
        completed: true,
        roleLinks: 0,
      })
    } finally {
      await withDatabase(
        false,
        (db) => db.prepare('DELETE FROM users WHERE email = ?').run(second),
        STATE_DIR,
      )
    }
  })

  test('shows the login screen, not the setup screen, once a user exists', async ({ page }) => {
    await interrupted(STALE_CLAIM_MS)

    await page.goto('/admin', { waitUntil: 'domcontentloaded' })

    await expect(page).toHaveURL(/\/admin\/login/)
  })
})
