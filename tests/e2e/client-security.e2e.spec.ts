// The owner-managed client security settings and what the native client route refuses.
//
// Not covered here, on purpose: a valid App Check token and Firebase ID token, ownership of a
// record, and quota exhaustion. Verifying a token fetches signing keys from fixed Google URLs, and
// a local Worker cannot serve keys of its own (nor should the product grow a test hook for it).
// Those cases stay with `pnpm test:firebase:runtime`, `pnpm test:api` and
// `tests/int/client-security.int.spec.ts`, which inject keys. See docs/e2e.md.
import { expect, test } from '@playwright/test'

import { ensureOwner, signInToken } from './helpers/access'
import { api } from './helpers/api'
import {
  DEFAULT_CONFIGURATION,
  manageHeaders,
  ORIGIN,
  readSettings,
  restoreDefaults,
  saveConfiguration,
  VALID_CONFIGURATION,
  writeSettings,
} from './helpers/client-security'
import { adminToken, signInThroughUi, uniqueIp } from './helpers/sign-in'

const ME = '/api/client/v1/me'

// API cases pass explicit tokens; the screens sign in or say otherwise.
test.use({ storageState: { cookies: [], origins: [] } })

/** The owner's token, for the case and for putting the settings back afterwards. */
async function ownerToken(request: Parameters<typeof ensureOwner>[0]): Promise<string> {
  return signInToken(request, await ensureOwner(request))
}

// The settings are shared state: whatever a test saves, the next one starts from revision 0's
// content again. Revisions only grow, so no test asserts an absolute revision number.
async function expectDefaults(request: Parameters<typeof ensureOwner>[0], token: string) {
  await restoreDefaults(request, token)
  expect((await readSettings(request, token)).snapshot.configuration).toEqual(DEFAULT_CONFIGURATION)
}

// Before as well as after, so a failed restore shows up as itself in the next test, not as a
// misleading failure of whichever test runs next.
test.beforeEach(async ({ request }) => {
  await expectDefaults(request, await ownerToken(request))
})
test.afterEach(async ({ request }) => {
  await expectDefaults(request, await ownerToken(request))
})

test.describe('The settings API', () => {
  test('only the owner reads or writes the settings', async ({ request }) => {
    const owner = await ownerToken(request)
    const denied = { status: 403, message: 'client_security_owner_required' }

    expect(await api(request, { method: 'GET', path: '/api/admin/client-security' })).toMatchObject(
      denied,
    )
    expect(
      await api(request, {
        method: 'GET',
        path: '/api/admin/client-security',
        token: adminToken(),
      }),
    ).toMatchObject(denied)
    expect(
      await writeSettings(request, adminToken(), {
        action: 'preview',
        expectedRevision: 0,
        configuration: VALID_CONFIGURATION,
      }),
    ).toMatchObject(denied)

    // Anonymous with the right headers is still refused: the owner check comes first.
    expect(
      await writeSettings(request, '', {
        action: 'preview',
        expectedRevision: 0,
        configuration: VALID_CONFIGURATION,
      }),
    ).toMatchObject(denied)

    const settings = await readSettings(request, owner)
    expect(settings.snapshot.configuration).toEqual(DEFAULT_CONFIGURATION)
    expect(settings.readiness.ready).toBe(false)
    // History is newest first and capped, so the first row is the current revision.
    expect(settings.history[0].revision).toBe(settings.snapshot.revision)
  })

  test('a write must come from the same origin with the manage header', async ({ request }) => {
    const owner = await ownerToken(request)
    const { snapshot } = await readSettings(request, owner)
    const body = {
      action: 'preview',
      expectedRevision: snapshot.revision,
      configuration: VALID_CONFIGURATION,
    }
    const refused = { status: 403, message: 'client_security_origin_required' }

    expect(await writeSettings(request, owner, body, { origin: ORIGIN })).toMatchObject(refused)
    expect(
      await writeSettings(request, owner, body, {
        'x-client-security-action': 'manage',
        origin: 'http://evil.example',
      }),
    ).toMatchObject(refused)
    expect(
      await writeSettings(request, owner, body, {
        ...manageHeaders,
        'sec-fetch-site': 'cross-site',
      }),
    ).toMatchObject(refused)
    expect((await writeSettings(request, owner, body)).status).toBe(200)
  })

  test('previews, saves and reads back a valid configuration', async ({ request }) => {
    const owner = await ensureOwner(request)
    const token = await signInToken(request, owner)
    const before = (await readSettings(request, token)).snapshot.revision
    const preview = await writeSettings(request, token, {
      action: 'preview',
      expectedRevision: before,
      configuration: VALID_CONFIGURATION,
    })
    expect(preview.body.changes.map((change: { field: string }) => change.field)).toContain(
      'firebase.enabled',
    )
    expect(JSON.parse(preview.body.canonical)).toEqual(VALID_CONFIGURATION)

    const revision = await saveConfiguration(request, token, VALID_CONFIGURATION)

    expect(revision).toBe(before + 1)
    const after = await readSettings(request, token)
    expect(after.snapshot.configuration).toEqual(VALID_CONFIGURATION)
    expect(after.readiness).toEqual({ ready: true, reasons: [] })
    expect(after.history[0]).toMatchObject({
      revision: before + 1,
      operation: 'save',
      actor: `users:${owner.id}`,
    })
    const audit = await api(request, {
      method: 'GET',
      path: '/api/client-security-audit?limit=1&sort=-revision',
      token,
    })
    expect(audit.body.docs[0]).toMatchObject({
      revision: before + 1,
      previousRevision: before,
      operation: 'save',
      actor: `users:${owner.id}`,
    })
  })

  test('refuses an invalid configuration, a wrong digest and a stale revision', async ({
    request,
  }) => {
    const token = await ownerToken(request)
    const { snapshot } = await readSettings(request, token)
    const preview = await writeSettings(request, token, {
      action: 'preview',
      expectedRevision: snapshot.revision,
      configuration: VALID_CONFIGURATION,
    })
    const save = (extra: Record<string, unknown>) =>
      writeSettings(request, token, {
        action: 'save',
        expectedRevision: snapshot.revision,
        configuration: VALID_CONFIGURATION,
        reviewedDigest: preview.body.digest,
        ...extra,
      })

    const invalid = await writeSettings(request, token, {
      action: 'preview',
      expectedRevision: snapshot.revision,
      configuration: {
        ...VALID_CONFIGURATION,
        firebase: { ...VALID_CONFIGURATION.firebase, projectNumber: 'abc' },
      },
    })
    expect(invalid).toMatchObject({ status: 400, message: 'client_security_invalid_configuration' })
    expect(await save({ reviewedDigest: 'a'.repeat(64) })).toMatchObject({
      status: 400,
      message: 'client_security_review_required',
    })
    const { schemaVersion: _omitted, ...withoutVersion } = VALID_CONFIGURATION
    expect(
      await writeSettings(request, token, {
        action: 'preview',
        expectedRevision: snapshot.revision,
        configuration: withoutVersion,
      }),
    ).toMatchObject({ status: 400, message: 'client_security_invalid_configuration' })
    expect(
      await writeSettings(request, token, {
        action: 'preview',
        expectedRevision: snapshot.revision,
        configuration: VALID_CONFIGURATION,
        unexpected: true,
      }),
    ).toMatchObject({ status: 400, message: 'client_security_invalid_operation' })
    expect((await readSettings(request, token)).snapshot.revision).toBe(snapshot.revision)

    // Stale: another save moves the revision on, then a save at the old revision is refused.
    await saveConfiguration(request, token, VALID_CONFIGURATION)
    expect(await save({})).toMatchObject({
      status: 409,
      message: 'client_security_revision_conflict',
    })
  })

  test('rolls back to an earlier revision as a new revision', async ({ request }) => {
    const token = await ownerToken(request)
    const saved = await saveConfiguration(request, token, VALID_CONFIGURATION)
    const body = { expectedRevision: saved, rollbackRevision: 0 }

    const preview = await writeSettings(request, token, { action: 'previewRollback', ...body })
    expect(preview.status).toBe(200)
    const rollback = await writeSettings(request, token, {
      action: 'rollback',
      ...body,
      reviewedDigest: preview.body.digest,
    })

    expect(rollback.status).toBe(200)
    expect(rollback.body.snapshot.revision).toBe(saved + 1)
    const after = await readSettings(request, token)
    expect(after.snapshot.configuration).toEqual(DEFAULT_CONFIGURATION)
    expect(after.history[0]).toMatchObject({ revision: saved + 1, operation: 'rollback' })
  })
})

test.describe('The native client route', () => {
  test('is closed while the settings are disabled', async ({ request }) => {
    const bare = await api(request, { method: 'GET', path: ME })
    const garbage = await api(request, {
      method: 'GET',
      path: ME,
      headers: { 'x-firebase-appcheck': 'abc', authorization: 'Bearer def' },
    })

    expect(bare).toMatchObject({ status: 503, message: 'firebase_client_disabled' })
    expect(garbage).toMatchObject({ status: 503, message: 'firebase_client_disabled' })
  })

  test('rejects missing and invalid credentials once enabled', async ({ request }) => {
    await saveConfiguration(request, await ownerToken(request), VALID_CONFIGURATION)

    const missing = await api(request, { method: 'GET', path: ME })
    const garbage = await api(request, {
      method: 'GET',
      path: ME,
      headers: { 'x-firebase-appcheck': 'abc', authorization: 'Bearer def' },
    })
    const post = await request.fetch(ME, { method: 'POST', data: {} })
    const raw = await request.get(ME)

    expect(missing).toMatchObject({ status: 401, message: 'firebase_credentials_missing' })
    expect(garbage).toMatchObject({ status: 401, message: 'firebase_credentials_invalid' })
    expect(post.status()).toBe(405)
    expect(raw.headers()['cache-control']).toContain('no-store')
  })
})

test.describe('The settings panel', () => {
  test('the owner saves settings from the panel', async ({ page, request }) => {
    const owner = await ensureOwner(request)
    const token = await signInToken(request, owner)
    const before = (await readSettings(request, token)).snapshot.revision

    await signInThroughUi(page, { ...owner, ip: uniqueIp() })
    await page.waitForURL(/\/admin\/?$/)
    await page.goto('/admin/client-security', { waitUntil: 'domcontentloaded' })
    const panel = page.locator('section.client-security-panel')
    await expect(panel.getByText(`Saved revision ${before}.`).first()).toBeVisible()

    await panel.getByLabel('Enable the native client API').check()
    await panel.getByLabel('Firebase project ID', { exact: true }).fill('e2e-project')
    await panel.getByLabel('Firebase project number', { exact: true }).fill('123456789')
    await panel.getByLabel('Allowed Firebase App IDs').fill('1:123456789:android:abcdef123456')
    await panel.getByLabel('Requests per UID', { exact: true }).fill('5')
    await panel.getByLabel('Requests per IP', { exact: true }).fill('10')
    await panel.getByLabel('Requests across all clients', { exact: true }).fill('100')

    const isWrite = (action: string) => (response: import('@playwright/test').Response) =>
      new URL(response.url()).pathname === '/api/admin/client-security' &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON()?.action === action
    const [preview] = await Promise.all([
      page.waitForResponse(isWrite('preview')),
      panel.getByRole('button', { name: 'Preview changes', exact: true }).click(),
    ])
    expect(preview.status()).toBe(200)
    await panel.getByRole('checkbox', { name: /I reviewed these Firebase trust settings/ }).check()
    const [save] = await Promise.all([
      page.waitForResponse(isWrite('save')),
      panel.getByRole('button', { name: 'Save reviewed settings', exact: true }).click(),
    ])

    expect(save.status()).toBe(200)
    await expect(panel.getByText(`Saved revision ${before + 1}.`).first()).toBeVisible()
    const stored = await readSettings(request, token)
    expect(stored.snapshot.configuration).toEqual(VALID_CONFIGURATION)
  })
})
