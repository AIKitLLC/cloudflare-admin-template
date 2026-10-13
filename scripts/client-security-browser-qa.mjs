import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { register } from 'tsx/esm/api'

// Real headless Chromium drives the compiled admin UI and its actual HTTP API.
// Storage, users, owner bootstrap, sessions, and counters are isolated local fixtures.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, '.qa/client-security/browser')
const reportPath = resolve(output, 'report.json')
const originalNodeEnv = process.env.NODE_ENV
const originalFetch = globalThis.fetch
const unregister = register()
const start = performance.now()
const endpoint = '/api/admin/client-security'
const password = 'synthetic-browser-qa-password-never-used-for-deployment'
const ownerEmail = 'browser-qa-owner@fixture.invalid'
const adminEmail = 'browser-qa-admin@fixture.invalid'
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const observations = [],
  apiEvents = [],
  screenshots = [],
  browserErrors = [],
  assetFailures = [],
  pageDiagnostics = [],
  serverRequestDiagnostics = []
const servedStaticAssets = new Map()
const blockedServerRequests = [],
  blockedBrowserRequests = []
let blockedTelemetryRequests = 0
let syntheticProviderRequests = 0
let runtimeModule, runtime, seedPayload, app, server, browser, baseUrl, store
let sourceHashes, buildHashes, buildId, browserVersion, failure
let ownerId, originalCounters
const sourceFiles = [
  'scripts/client-security-browser-qa.mjs',
  'tests/int/local-runtime.ts',
  'tests/int/firebase-fixture.ts',
  'src/auth/client-security-owner.ts',
  'src/client-security/admin-route.ts',
  'src/client-security/initialize.ts',
  'src/client-security/schema.ts',
  'src/client-security/store.ts',
  'src/client-security/rate-limits.ts',
  'src/components/ClientSecurityView.tsx',
  'src/components/ClientSecurityPanel.tsx',
  'src/components/ClientSecurityNav.tsx',
  'src/collections/ClientSecurity.ts',
  'src/collections/Users.ts',
  'src/app/api/admin/client-security/route.ts',
  'src/app/(payload)/admin/importMap.js',
  'src/payload.config.ts',
  'next.config.ts',
  'package.json',
  'pnpm-lock.yaml',
]
const hashes = async (paths) =>
  Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))]),
    ),
  )
async function buildFiles(directory) {
  const result = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name)
    if (item.isDirectory()) result.push(...(await buildFiles(path)))
    else if (/\.(?:js|json|css)$/.test(item.name)) result.push(relative(root, path))
  }
  return result
}
async function test(name, callback) {
  const before = apiEvents.length
  try {
    const detail = await callback()
    observations.push({ name, status: 'PASS', apiEvents: apiEvents.slice(before), ...detail })
  } catch (error) {
    for (const [index, page] of (
      browser?.contexts().flatMap((context) => context.pages()) ?? []
    ).entries()) {
      if (new URL(page.url()).pathname === '/admin/client-security') {
        try {
          await screenshot(page, `failure-page-${index}`)
          pageDiagnostics.push(
            await page.evaluate(() => ({
              pathname: location.pathname,
              externalScripts: Array.from(document.scripts)
                .filter(({ src }) => src)
                .map(({ src }) => new URL(src).pathname),
              stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(
                ({ href }) => new URL(href).pathname,
              ),
              bodyClasses: document.body.className,
              loadingSettingsVisible: document.body.innerText.includes('Loading saved settings'),
            })),
          )
        } catch {
          /* Diagnostics cannot hide the failed check. */
        }
      }
    }
    observations.push({
      name,
      status: 'FAIL',
      apiEvents: apiEvents.slice(before),
      errorType: error.name,
      errorDigest: sha256(error.message),
      errorMessage: error.message
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, '[redacted-token]')
        .replaceAll(password, '[redacted-password]')
        .slice(0, 2000),
    })
    // Assertions and browser error bodies never enter the report or terminal.
    throw new Error(`Browser QA check failed: ${name}`)
  }
}
const panel = (page) => page.locator('section.client-security-panel')
const button = (page, name) => panel(page).getByRole('button', { name, exact: true })
const field = (page, name) =>
  panel(page).getByLabel(name, {
    exact: !['Allowed Firebase App IDs', 'Revision to restore'].includes(name),
  })
const review = (page) =>
  panel(page).getByRole('checkbox', { name: /I reviewed these Firebase trust settings/ })
const posts = (action) =>
  apiEvents.filter((item) => item.method === 'POST' && item.action === action).length
async function counters() {
  return (
    await runtime.platform.env.D1.prepare(
      'SELECT bucket_key, used, reset_at FROM client_security_counters ORDER BY bucket_key',
    ).all()
  ).results
}
async function screenshot(page, name) {
  const path = resolve(output, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  screenshots.push({ name, path: relative(root, path), sha256: sha256(await readFile(path)) })
}
async function waitState(page, revision) {
  await expect(
    panel(page)
      .getByText(new RegExp(`Saved revision ${revision}\\.`))
      .first(),
  ).toBeVisible({ timeout: 20_000 })
  await expect(button(page, 'Reload saved settings')).toBeEnabled()
}
async function action(page, actionName, click, expectedStatus = 200) {
  const beforeServer = serverRequestDiagnostics.length
  const pending = page.waitForResponse((response) => {
    const request = response.request()
    return (
      new URL(response.url()).pathname === endpoint &&
      request.method() === 'POST' &&
      request.postDataJSON()?.action === actionName
    )
  })
  await click()
  const response = await pending
  assert.equal(response.status(), expectedStatus, 'settings API status')
  if (response.status() >= 400) {
    // The real UI deliberately discards error bodies. Chromium can release them
    // before CDP reads them, so verify the same completed response's public code
    // from the passive local HTTP diagnostics rather than inventing a response.
    await expect
      .poll(
        () =>
          serverRequestDiagnostics
            .slice(beforeServer)
            .find(({ method, status }) => method === 'POST' && status === expectedStatus)
            ?.errorReason,
      )
      .toBeDefined()
    return {
      error: serverRequestDiagnostics
        .slice(beforeServer)
        .find(({ method, status }) => method === 'POST' && status === expectedStatus).errorReason,
    }
  }
  const body = await response.json()
  return body
}
async function preview(page) {
  const value = await action(page, 'preview', () => button(page, 'Preview changes').click())
  await expect(
    panel(page).getByRole('heading', { name: 'Review changes', exact: true }),
  ).toBeVisible()
  return value
}
async function loginContext(email, name) {
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 1280, height: 960 },
  })
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === baseUrl) return route.continue()
    blockedBrowserRequests.push({ context: name, origin: url.origin })
    return route.abort('blockedbyclient')
  })
  const response = await context.request.post('/api/users/login', { data: { email, password } })
  assert.equal(response.status(), 200, 'synthetic Payload session login must succeed')
  const cookies = await context.cookies()
  assert.ok(cookies.some((cookie) => cookie.name === 'payload-token' && cookie.httpOnly))
  context.on('page', (page) => {
    page.on('console', (message) => {
      if (message.type() === 'error')
        browserErrors.push({
          context: name,
          kind: 'console-error',
          messageSha256: sha256(message.text()),
          locationPath: message.location().url
            ? new URL(message.location().url).pathname
            : undefined,
        })
    })
    page.on('pageerror', (error) =>
      browserErrors.push({
        context: name,
        kind: 'pageerror',
        name: error.name,
        messageSha256: sha256(error.message),
      }),
    )
    page.on('response', (response) => {
      const pathname = new URL(response.url()).pathname
      if (pathname.startsWith('/_next/') && response.status() >= 400)
        assetFailures.push({ context: name, pathname, status: response.status() })
      if (pathname !== endpoint) return
      const request = response.request()
      const data = request.method() === 'POST' ? request.postDataJSON() : undefined
      const headers = response.headers()
      apiEvents.push({
        context: name,
        method: request.method(),
        action: data?.action,
        expectedRevision: data?.expectedRevision,
        rollbackRevision: data?.rollbackRevision,
        status: response.status(),
        cacheControl: headers['cache-control'],
        vary: headers.vary,
        sameOrigin: request.headers().origin === baseUrl,
        secFetchSite: request.headers()['sec-fetch-site'],
        customActionHeader: request.headers()['x-client-security-action'] === 'manage',
      })
    })
  })
  return context
}

try {
  for (const path of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    assert.equal(
      await access(resolve(root, path)).then(
        () => true,
        () => false,
      ),
      false,
      'browser QA must not load real environment files',
    )
  }
  await access(chromium.executablePath())
  await mkdir(output, { recursive: true })
  sourceHashes = await hashes(sourceFiles)
  buildId = (await readFile(resolve(root, '.next/BUILD_ID'), 'utf8')).trim()
  const artifacts = [
    '.next/BUILD_ID',
    '.next/required-server-files.json',
    ...(await buildFiles(resolve(root, '.next/server'))),
    ...(await buildFiles(resolve(root, '.next/static'))),
  ].sort()
  buildHashes = await hashes(artifacts)
  const builtConfig = JSON.parse(
    await readFile(resolve(root, '.next/required-server-files.json'), 'utf8'),
  ).config
  process.env.NODE_ENV = 'test'
  runtimeModule = await import('../tests/int/local-runtime.ts')
  await runtimeModule.startLocalIntegrationRuntime()
  runtime = runtimeModule.localIntegrationRuntime()
  const syntheticFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (
      [
        'https://firebaseappcheck.googleapis.com/v1/jwks',
        'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
      ].includes(url.href)
    ) {
      syntheticProviderRequests++
      return syntheticFetch(input, init)
    }
    if (url.href === 'https://telemetry.payloadcms.com/events') {
      blockedTelemetryRequests++
      throw new Error('Browser QA blocks Payload telemetry')
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      blockedServerRequests.push(url.origin)
      throw new Error('Browser QA prohibits external fetches')
    }
    return syntheticFetch(input, init)
  }
  const { getPayload } = await import('payload')
  const { default: config } = await import('../src/payload.config.ts')
  seedPayload = await getPayload({ config, key: 'browser-qa-seed' })
  runtimeModule.registerIntegrationPayload(seedPayload)
  await seedPayload.create({ collection: 'users', data: { email: adminEmail, password } })
  ownerId = (
    await seedPayload.create({ collection: 'users', data: { email: ownerEmail, password } })
  ).id
  const { initializeClientSecuritySchema } = await import('../src/client-security/initialize.ts')
  const { createClientSecurityStore } = await import('../src/client-security/store.ts')
  await initializeClientSecuritySchema(runtime.platform.env.D1)
  store = createClientSecurityStore(runtime.platform.env.D1)
  const bootstrap = await runtime.platform.env.D1.prepare(
    "UPDATE users SET role = 'owner' WHERE id = ? AND role = 'admin' AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner')",
  )
    .bind(ownerId)
    .run()
  assert.equal(bootstrap.meta.changes, 1)
  const resetAt = Math.floor(Date.now() / 1000) + 600
  await runtime.platform.env.D1.batch(
    ['uid', 'ip', 'global'].map((dimension, index) =>
      runtime.platform.env.D1.prepare(
        'INSERT INTO client_security_counters (bucket_key, used, reset_at) VALUES (?, ?, ?)',
      ).bind(sha256(`synthetic-browser-counter:${dimension}`), index + 3, resetAt),
    ),
  )
  originalCounters = await counters()
  await seedPayload.destroy()
  seedPayload = undefined
  process.env.NODE_ENV = 'production'
  const next = (await import('next')).default
  const { getRequestMeta } = await import('next/dist/server/request-meta.js')
  let handler
  server = createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url, 'http://isolated.fixture.invalid').pathname
      if (pathname.startsWith('/_next/static/')) {
        // getRequestHandler is Next's compiled application handler; its separate
        // filesystem router is absent from this minimal local server. Serve the
        // unchanged built bytes, as that router would, without mocking browser APIs.
        const staticRoot = resolve(root, '.next/static')
        const path = resolve(
          staticRoot,
          decodeURIComponent(pathname.slice('/_next/static/'.length)),
        )
        if (!path.startsWith(`${staticRoot}/`) || !['GET', 'HEAD'].includes(req.method)) {
          res.writeHead(404)
          res.end()
          return
        }
        let bytes
        try {
          bytes = await readFile(path)
        } catch {
          res.writeHead(404)
          res.end()
          return
        }
        const contentType = path.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : path.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : path.endsWith('.woff2')
              ? 'font/woff2'
              : path.endsWith('.woff')
                ? 'font/woff'
                : path.endsWith('.svg')
                  ? 'image/svg+xml'
                  : path.endsWith('.png')
                    ? 'image/png'
                    : path.endsWith('.json')
                      ? 'application/json'
                      : 'application/octet-stream'
        servedStaticAssets.set(relative(root, path), sha256(bytes))
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
        })
        res.end(req.method === 'HEAD' ? undefined : bytes)
        return
      }
      if (!handler) {
        res.writeHead(503)
        res.end()
        return
      }
      const responseChunks = []
      if (pathname === endpoint) {
        const write = res.write,
          end = res.end
        const record = (chunk) => {
          if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
            if (responseChunks.reduce((size, bytes) => size + bytes.length, 0) < 16_384)
              responseChunks.push(Buffer.from(chunk))
          }
        }
        res.write = function (chunk, ...args) {
          record(chunk)
          return write.call(this, chunk, ...args)
        }
        res.end = function (chunk, ...args) {
          record(chunk)
          return end.call(this, chunk, ...args)
        }
      }
      if (pathname === endpoint) {
        res.once('finish', () => {
          const initUrl = getRequestMeta(req, 'initURL')
          serverRequestDiagnostics.push({
            method: req.method,
            status: res.statusCode,
            originMatchesServer: req.headers.origin === baseUrl,
            secFetchSite: req.headers['sec-fetch-site'],
            cookieSent: Boolean(req.headers.cookie),
            customActionHeader: req.headers['x-client-security-action'] === 'manage',
            errorReason: /"error"\s*:\s*"([a-z_]+)"/.exec(
              Buffer.concat(responseChunks).toString('utf8'),
            )?.[1],
            requestOriginMatchesServer:
              typeof initUrl === 'string' &&
              new URL(initUrl, 'http://relative.fixture.invalid').origin === baseUrl,
          })
        })
      }
      await handler(req, res)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, 'localhost', done)
  })
  baseUrl = `http://localhost:${server.address().port}`
  // Next needs the real listening origin to construct Request.url for its normal
  // same-origin CSRF checks. A bare getRequestHandler otherwise uses a relative URL.
  app = next({
    customServer: false,
    dev: false,
    dir: root,
    conf: builtConfig,
    hostname: 'localhost',
    port: server.address().port,
  })
  await app.prepare()
  assert.equal(globalThis[Symbol.for('__cloudflare-context__')].env, runtime.env)
  handler = app.getRequestHandler()
  browser = await chromium.launch({ headless: true })
  browserVersion = browser.version()
  const adminContext = await loginContext(adminEmail, 'ordinary-admin')
  const ownerContext = await loginContext(ownerEmail, 'owner-a')
  const adminPage = await adminContext.newPage()
  const ownerPage = await ownerContext.newPage()

  await test('ordinary-admin-denied-settings-and-owner-controls', async () => {
    await adminPage.goto('/admin/client-security')
    await expect(
      adminPage.getByRole('heading', { name: 'Access denied', exact: true }),
    ).toBeVisible()
    await expect(panel(adminPage)).toHaveCount(0)
    const result = await adminPage.evaluate(async () => {
      const response = await fetch('/api/admin/client-security', { cache: 'no-store' })
      return { status: response.status, body: await response.json() }
    })
    assert.deepEqual(result, { status: 403, body: { error: 'client_security_owner_required' } })
    return { settingsStatus: result.status, ownerControlsMounted: false }
  })
  await test('owner-hydrates-default-disabled-blank-readiness', async () => {
    await ownerPage.goto('/admin/client-security')
    await waitState(ownerPage, 0)
    await expect(
      panel(ownerPage).getByRole('heading', { name: 'Client security', exact: true }),
    ).toBeVisible()
    await expect(field(ownerPage, 'Enable the native client API')).not.toBeChecked()
    for (const name of [
      'Firebase project ID',
      'Firebase project number',
      'Allowed Firebase App IDs',
    ])
      await expect(field(ownerPage, name)).toHaveValue('')
    for (const text of [
      'Client access is disabled.',
      'Public Firebase identifiers are missing.',
      'Zero quotas block requests: UID, IP, all clients.',
    ])
      await expect(panel(ownerPage).getByText(text, { exact: true })).toBeVisible()
    await screenshot(ownerPage, 'owner-default-disabled')
    return {
      revision: 0,
      firebaseEnabled: false,
      missingIdentifiersVisible: true,
      zeroQuotasVisible: true,
    }
  })
  await test('enabled-blank-form-native-validation-prevents-preview', async () => {
    const before = posts('preview')
    await field(ownerPage, 'Enable the native client API').check()
    await button(ownerPage, 'Preview changes').click()
    assert.equal(
      await field(ownerPage, 'Firebase project ID').evaluate(
        (element) => element.validity.valueMissing,
      ),
      true,
    )
    assert.equal(posts('preview'), before)
    assert.equal((await store.read()).revision, 0)
    await field(ownerPage, 'Enable the native client API').uncheck()
    return { actualApiPosts: 0, durableFirebaseEnabled: false }
  })
  await test('quota-bounds-and-integer-html-validation-prevent-posts', async () => {
    const before = posts('preview')
    const checks = [
      ['Quota window (seconds)', '9', 'rangeUnderflow'],
      ['Quota window (seconds)', '3601', 'rangeOverflow'],
      ['Quota window (seconds)', '60.5', 'stepMismatch'],
      ['Requests per UID', '-1', 'rangeUnderflow'],
      ['Requests per UID', '1000001', 'rangeOverflow'],
    ]
    for (const [name, value, validity] of checks) {
      await field(ownerPage, name).fill(value)
      await button(ownerPage, 'Preview changes').click()
      assert.equal(
        await field(ownerPage, name).evaluate((element, key) => element.validity[key], validity),
        true,
      )
      await field(ownerPage, name).fill(name === 'Quota window (seconds)' ? '60' : '0')
    }
    assert.equal(posts('preview'), before)
    assert.equal((await store.read()).revision, 0)
    return { checkedBounds: checks.length, actualApiPosts: 0 }
  })
  await test('partial-firebase-configuration-server-rejection-is-visible', async () => {
    await field(ownerPage, 'Firebase project ID').fill('invalid project')
    const result = await action(
      ownerPage,
      'preview',
      () => button(ownerPage, 'Preview changes').click(),
      400,
    )
    assert.deepEqual(result, { error: 'client_security_invalid_configuration' })
    await expect(panel(ownerPage).getByRole('alert')).toContainText(
      'The server rejected this change.',
    )
    assert.equal((await store.read()).revision, 0)
    await field(ownerPage, 'Firebase project ID').fill('')
    return { actualApiStatus: 400, draftNeverCommitted: true }
  })
  await test('preview-requires-review-and-draft-edit-invalidates-it', async () => {
    await field(ownerPage, 'Quota window (seconds)').fill('120')
    await field(ownerPage, 'Requests per UID').fill('2')
    await field(ownerPage, 'Requests per IP').fill('3')
    await field(ownerPage, 'Requests across all clients').fill('5')
    const result = await preview(ownerPage)
    assert.equal(result.readiness.ready, false)
    await expect(button(ownerPage, 'Save reviewed settings')).toBeDisabled()
    assert.equal((await store.read()).revision, 0)
    await review(ownerPage).check()
    await expect(button(ownerPage, 'Save reviewed settings')).toBeEnabled()
    await field(ownerPage, 'Requests per UID').fill('3')
    await expect(button(ownerPage, 'Save reviewed settings')).toHaveCount(0)
    assert.equal((await store.read()).revision, 0)
    await preview(ownerPage)
    await expect(review(ownerPage)).not.toBeChecked()
    await expect(button(ownerPage, 'Save reviewed settings')).toBeDisabled()
    await screenshot(ownerPage, 'review-required-preview')
    return { reviewRequired: true, editsInvalidatePreview: true, durableRevision: 0 }
  })
  await test('reviewed-save-double-click-commits-one-disabled-revision', async () => {
    await review(ownerPage).check()
    const before = posts('save')
    await action(ownerPage, 'save', () =>
      button(ownerPage, 'Save reviewed settings').dblclick({ delay: 40 }),
    )
    await waitState(ownerPage, 1)
    assert.equal(posts('save') - before, 1)
    const saved = await store.read()
    assert.equal(saved.configuration.firebase.enabled, false)
    assert.equal(saved.configuration.firebase.projectId, '')
    assert.equal(saved.configuration.limits.uid, 3)
    assert.deepEqual(await counters(), originalCounters)
    return { actualSavePosts: 1, revision: 1, firebaseEnabled: false, countersPreserved: true }
  })
  const secondOwnerContext = await loginContext(ownerEmail, 'owner-b')
  const secondPage = await secondOwnerContext.newPage()
  await test('two-independent-owner-pages-preview-the-same-revision', async () => {
    await secondPage.goto('/admin/client-security')
    await waitState(secondPage, 1)
    await field(ownerPage, 'Requests per UID').fill('4')
    await field(secondPage, 'Requests per UID').fill('6')
    const first = await preview(ownerPage),
      second = await preview(secondPage)
    assert.equal(first.currentRevision, 1)
    assert.equal(second.currentRevision, 1)
    await review(ownerPage).check()
    await review(secondPage).check()
    return { separateBrowserContexts: true, previewRevisionA: 1, previewRevisionB: 1 }
  })
  await test('stale-owner-save-conflicts-and-locks-further-writes', async () => {
    await action(ownerPage, 'save', () => button(ownerPage, 'Save reviewed settings').click())
    await waitState(ownerPage, 2)
    const result = await action(
      secondPage,
      'save',
      () => button(secondPage, 'Save reviewed settings').click(),
      409,
    )
    assert.deepEqual(result, { error: 'client_security_revision_conflict' })
    await expect(panel(secondPage).getByRole('alert')).toContainText(
      'Another owner updated these settings.',
    )
    await expect(button(secondPage, 'Preview changes')).toBeDisabled()
    await expect(field(secondPage, 'Requests per UID')).toBeDisabled()
    assert.equal((await store.read()).configuration.limits.uid, 4)
    assert.equal((await store.history()).length, 3)
    assert.deepEqual(await counters(), originalCounters)
    await screenshot(secondPage, 'stale-revision-conflict')
    return {
      actualApiStatus: 409,
      winningRevision: 2,
      winningUidLimit: 4,
      staleControlsLocked: true,
    }
  })
  await test('stale-page-explicit-reload-discards-draft-and-unlocks', async () => {
    await button(secondPage, 'Reload saved settings').click()
    await waitState(secondPage, 2)
    await expect(field(secondPage, 'Requests per UID')).toHaveValue('4')
    await expect(button(secondPage, 'Preview changes')).toBeEnabled()
    await expect(panel(secondPage).getByRole('alert')).toHaveCount(0)
    return { revision: 2, staleDraftDiscarded: true }
  })
  await test('rollback-preview-requires-review-before-restoring', async () => {
    await field(ownerPage, 'Revision to restore').selectOption('0')
    const result = await action(ownerPage, 'previewRollback', () =>
      button(ownerPage, 'Preview rollback').click(),
    )
    assert.equal(result.currentRevision, 2)
    assert.equal(result.configuration.firebase.enabled, false)
    await expect(
      panel(ownerPage).getByRole('heading', { name: 'Review rollback to revision 0', exact: true }),
    ).toBeVisible()
    await expect(button(ownerPage, 'Restore reviewed settings')).toBeDisabled()
    assert.equal((await store.read()).revision, 2)
    await review(ownerPage).check()
    return { rollbackTarget: 0, durableRevisionBeforeReview: 2, reviewRequired: true }
  })
  await test('reviewed-rollback-creates-history-and-preserves-counters', async () => {
    await action(ownerPage, 'rollback', () =>
      button(ownerPage, 'Restore reviewed settings').click(),
    )
    await waitState(ownerPage, 3)
    const saved = await store.read()
    const historical = await store.readVersion(0)
    assert.deepEqual(saved.configuration, historical.configuration)
    assert.equal(saved.configuration.firebase.enabled, false)
    assert.deepEqual(await counters(), originalCounters)
    const history = await store.history()
    assert.deepEqual(
      history.map(({ revision, operation }) => ({ revision, operation })),
      [
        { revision: 3, operation: 'rollback' },
        { revision: 2, operation: 'save' },
        { revision: 1, operation: 'save' },
        { revision: 0, operation: 'initialize' },
      ],
    )
    await expect(
      panel(ownerPage).getByRole('cell', { name: 'rollback', exact: true }),
    ).toBeVisible()
    await screenshot(ownerPage, 'rollback-preserved-counters')
    return {
      revision: 3,
      restoredConfigurationRevision: 0,
      countersPreserved: true,
      historyEntries: 4,
    }
  })
  await test('browser-reload-verifies-durable-state-and-real-api-boundary', async () => {
    await secondPage.reload()
    await waitState(secondPage, 3)
    await expect(field(secondPage, 'Requests per UID')).toHaveValue('0')
    await expect(field(secondPage, 'Enable the native client API')).not.toBeChecked()
    const writes = apiEvents.filter(({ method }) => method === 'POST')
    assert.ok(writes.length >= 8)
    for (const event of apiEvents) {
      assert.equal(event.cacheControl, 'private, no-store')
      const vary = event.vary?.split(',').map((value) => value.trim().toLowerCase())
      assert.ok(vary?.includes('authorization'))
      assert.ok(vary?.includes('cookie'))
      if (event.method === 'POST') {
        assert.equal(event.sameOrigin, true)
        assert.equal(event.customActionHeader, true)
      }
    }
    assert.equal(browserErrors.filter(({ kind }) => kind === 'pageerror').length, 0)
    assert.equal(
      browserErrors.filter(
        ({ kind, locationPath }) => kind === 'console-error' && locationPath !== endpoint,
      ).length,
      0,
    )
    assert.equal(assetFailures.length, 0)
    assert.ok(servedStaticAssets.size > 0)
    assert.equal(blockedServerRequests.length, 0)
    assert.equal(blockedBrowserRequests.length, 0)
    assert.equal(syntheticProviderRequests, 0)
    assert.equal((await store.read()).configuration.firebase.enabled, false)
    assert.deepEqual(await counters(), originalCounters)
    return {
      revision: 3,
      realBrowserApiWrites: writes.length,
      mockedBrowserApiRequests: 0,
      firebaseActivated: false,
      browserPageErrors: 0,
    }
  })
  assert.deepEqual(
    await hashes(sourceFiles),
    sourceHashes,
    'source changed during browser verification',
  )
  assert.deepEqual(
    await hashes(artifacts),
    buildHashes,
    'compiled artifacts changed during browser verification',
  )
} catch (error) {
  failure = error
} finally {
  try {
    await browser?.close()
    if (server) {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    }
    await app?.close()
  } catch {
    failure ??= new Error('Browser QA browser/server cleanup failed')
  }
  try {
    const productionPayload = globalThis._payload?.get('default')?.payload
    if (productionPayload) runtimeModule?.registerIntegrationPayload(productionPayload)
    await runtimeModule?.disposeLocalIntegrationRuntime()
  } catch {
    failure ??= new Error('Browser QA local storage cleanup failed')
  } finally {
    globalThis.fetch = originalFetch
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    await unregister()
  }
}

const report = {
  status: failure ? 'FAIL' : 'PASS',
  checks: observations.length,
  passedChecks: observations.filter(({ status }) => status === 'PASS').length,
  failedChecks: observations.filter(({ status }) => status === 'FAIL').map(({ name }) => name),
  setupOrCleanupFailure: Boolean(failure && !observations.some(({ status }) => status === 'FAIL')),
  failureMessage: failure?.message.startsWith('Browser QA')
    ? failure.message
    : failure
      ? 'Browser QA setup or fingerprint check failed'
      : undefined,
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  sourceHashes,
  dependencyLockSha256: sourceHashes?.['pnpm-lock.yaml'],
  buildId,
  buildHashes,
  nodeVersion: process.version,
  browser: 'independent headless Playwright Chromium',
  browserVersion,
  playwrightVersion: JSON.parse(
    await readFile(resolve(root, 'node_modules/@playwright/test/package.json'), 'utf8'),
  ).version,
  elapsedMs: Math.round(performance.now() - start),
  apiEvents,
  screenshots,
  browserErrors,
  assetFailures,
  pageDiagnostics,
  serverRequestDiagnostics,
  servedStaticAssetsSha256: Object.fromEntries(servedStaticAssets),
  staticAssetBridge:
    'The minimal Next application handler excludes its filesystem asset router. This isolated server serves exact .next/static bytes with recorded hashes; SSR and all API routes use the actual compiled Next/Payload handlers.',
  realProviderRequests: 0,
  syntheticProviderRequests,
  paidAiCalls: 0,
  blockedServerRequests,
  blockedBrowserRequests,
  blockedTelemetryRequests,
  realFirebaseProviderFlow: 'NOT_RUN',
  productionR2Download: 'NOT_RUN',
  scope:
    'Actual compiled Next/Payload admin page, hydrated React controls, real browser same-origin settings requests, real Payload HTTP sessions, ephemeral local D1/R2 and synthetic owner bootstrap. No browser API mocks; all committed Firebase configurations stay disabled.',
  exclusions: [
    'Production user/settings state',
    'Deployed Cloudflare header provenance',
    'Real Firebase client enrollment',
    'Production R2 download',
  ],
  observations,
}
await mkdir(output, { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
if (failure) {
  console.error(report.failureMessage)
  process.exitCode = 1
} else
  console.log(
    `PASS ${report.passedChecks} real Chromium client-security UI checks; Firebase remained disabled; zero real provider or AI calls.`,
  )
