import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { register } from 'tsx/esm/api'

// Runs the compiled production router, with ephemeral D1/R2 storage and keys.
// No browser, environment files, Firebase provider, deployment, or AI calls are used.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = resolve(root, '.qa/firebase-client/http-smoke.json')
const appEndpoint = 'https://firebaseappcheck.googleapis.com/v1/jwks'
const idEndpoint =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
const originalNodeEnv = process.env.NODE_ENV
const originalFetch = globalThis.fetch
const unregister = register()
const start = performance.now()
const observations = []
const providerRequests = []
const blockedExternalRequests = []
let blockedTelemetryRequests = 0
const sourceFiles = [
  'scripts/local-api-smoke.mjs',
  'tests/int/local-runtime.ts',
  'tests/int/firebase-fixture.ts',
  'src/auth/firebase-client.ts',
  'src/auth/firebase-client-route.ts',
  'src/auth/client-security-owner.ts',
  'src/client-security/admin-route.ts',
  'src/client-security/client-route.ts',
  'src/client-security/initialize.ts',
  'src/client-security/schema.ts',
  'src/client-security/store.ts',
  'src/client-security/rate-limits.ts',
  'src/components/ClientSecurityView.tsx',
  'src/components/ClientSecurityPanel.tsx',
  'src/components/ClientSecurityNav.tsx',
  'src/collections/ClientSecurity.ts',
  'src/app/api/admin/client-security/route.ts',
  'src/app/api/client/v1/me/route.ts',
  'src/app/(payload)/api/[...slug]/route.ts',
  'src/payload.config.ts',
  'src/collections/Users.ts',
  'src/collections/Media.ts',
  'next.config.ts',
  'package.json',
  'pnpm-lock.yaml',
]
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
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
    else if (/\.(?:js|json)$/.test(item.name)) result.push(relative(root, path))
  }
  return result
}
const urlOf = (input) =>
  new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
const mutateSignature = (token) => {
  const parts = token.split('.')
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1)
  return parts.join('.')
}
const rewriteHeader = (token, changes) => {
  const parts = token.split('.')
  parts[0] = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(parts[0], 'base64url').toString()), ...changes }),
  ).toString('base64url')
  return parts.join('.')
}

let runtimeModule, runtime, app, server, baseUrl, seedPayload
let sourceHashes, buildHashes, buildId
let failure
let outage
let adminToken
let adminCookie
let seededAdminId
let mediaFilename
const mediaBody = 'Synthetic public media fixture. No user data.\n'
const adminEmail = 'http-smoke-admin@fixture.invalid'
const adminPassword = 'synthetic-http-smoke-password-never-used-for-deployment'
let appPair
let securityStore
let digestSecurityConfiguration
let enabledConfiguration
const appKid = 'http-smoke-app-key'

async function request(path, { method = 'GET', headers, body } = {}) {
  const requestHeaders = new Headers(headers)
  // This loopback Node server simulates the trusted header populated by Cloudflare.
  // The matching synthetic incoming-request context is set explicitly below.
  if (path.startsWith('/api/client/v1/me') && !requestHeaders.has('CF-Connecting-IP'))
    requestHeaders.set('CF-Connecting-IP', '203.0.113.10')
  const response = await originalFetch(`${baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    // Method-only and media responses do not have JSON bodies.
  }
  return { response, json, text }
}

async function test(name, callback) {
  const before = providerRequests.length
  const requests = []
  const recordedRequest = async (path, options) => {
    const result = await request(path, options)
    requests.push({ method: options?.method ?? 'GET', path, status: result.response.status })
    return result
  }
  try {
    const detail = await callback(recordedRequest)
    observations.push({
      name,
      status: 'PASS',
      requests,
      syntheticProviderRequests: providerRequests.slice(before),
      ...detail,
    })
  } catch (error) {
    observations.push({
      name,
      status: 'FAIL',
      requests,
      syntheticProviderRequests: providerRequests.slice(before),
    })
    // Only the check name is emitted. Assertions must never dump credentials or login bodies.
    failure ??= new Error(`HTTP smoke check failed: ${name}`, { cause: error })
  }
}

function privateHeaders(response, status) {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  const vary = response.headers
    .get('Vary')
    ?.split(',')
    .map((value) => value.trim().toLowerCase())
  assert.ok(vary?.includes('authorization'))
  assert.ok(vary?.includes('x-firebase-appcheck'))
  assert.equal(response.headers.get('WWW-Authenticate'), status === 401 ? 'Bearer' : null)
  assert.equal(response.headers.has('Set-Cookie'), false)
  assert.equal(response.headers.has('Access-Control-Allow-Origin'), false)
}

async function headers({ appClaims = {}, idClaims = {}, appHeader, idHeader } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const value = await runtime.fixture.headers(idClaims)
  let appToken = await new SignJWT({
    iss: `https://firebaseappcheck.googleapis.com/${runtime.env.FIREBASE_PROJECT_NUMBER}`,
    aud: [`projects/${runtime.env.FIREBASE_PROJECT_NUMBER}`],
    sub: runtime.env.FIREBASE_APP_IDS,
    iat: now - 10,
    exp: now + 3600,
    ...appClaims,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: appKid })
    .sign(appPair.privateKey)
  if (appHeader) appToken = rewriteHeader(appToken, appHeader)
  value.set('X-Firebase-AppCheck', appToken)
  if (idHeader) {
    value.set(
      'Authorization',
      `Bearer ${rewriteHeader(value.get('Authorization').slice(7), idHeader)}`,
    )
  }
  return value
}

const principal = () => ({
  uid: 'integration-anonymous-uid',
  appId: runtime.env.FIREBASE_APP_IDS,
  projectId: runtime.env.FIREBASE_PROJECT_ID,
})
async function expectClient(name, expectedStatus, options = {}, expectedReason) {
  await test(name, async (send) => {
    const credentials = options.headers ?? (await headers(options))
    if (options.ip) credentials.set('CF-Connecting-IP', options.ip)
    const result = await send(options.path ?? '/api/client/v1/me', {
      method: options.method,
      headers: credentials,
      body: options.body,
    })
    assert.equal(result.response.status, expectedStatus)
    privateHeaders(result.response, expectedStatus)
    const retryAfter = result.response.headers.get('Retry-After')
    if (expectedStatus === 429) {
      assert.match(retryAfter ?? '', /^[1-9][0-9]*$/)
      assert.ok(Number(retryAfter) <= 60)
    } else assert.equal(retryAfter, null)
    if (options.method !== 'HEAD') {
      assert.deepEqual(
        result.json,
        expectedStatus === 200
          ? { principal: principal() }
          : { error: expectedReason ?? 'firebase_credentials_invalid' },
      )
    }
    for (const credential of [
      credentials.get('Authorization'),
      credentials.get('X-Firebase-AppCheck'),
    ]) {
      if (credential) assert.equal(result.text.includes(credential), false)
    }
    return { cacheControl: result.response.headers.get('Cache-Control'), retryAfter }
  })
}

async function saveSecurityConfiguration(configuration) {
  const snapshot = await securityStore.read()
  return securityStore.save({
    expectedRevision: snapshot.revision,
    configuration,
    reviewedDigest: await digestSecurityConfiguration(configuration),
    actor: 'synthetic-http-smoke',
    operation: 'save',
  })
}

function ownerHeaders(response) {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  const vary = response.headers
    .get('Vary')
    ?.split(',')
    .map((value) => value.trim().toLowerCase())
  assert.ok(vary?.includes('authorization'))
  assert.ok(vary?.includes('cookie'))
}

try {
  for (const path of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const exists = await access(resolve(root, path)).then(
      () => true,
      () => false,
    )
    assert.equal(exists, false, 'HTTP smoke must not load real environment files')
  }
  sourceHashes = await hashes(sourceFiles)
  buildId = (await readFile(resolve(root, '.next/BUILD_ID'), 'utf8')).trim()
  const artifacts = [
    '.next/BUILD_ID',
    '.next/required-server-files.json',
    '.next/build-manifest.json',
    ...(await buildFiles(resolve(root, '.next/server'))),
  ].sort()
  buildHashes = await hashes(artifacts)
  const builtConfig = JSON.parse(
    await readFile(resolve(root, '.next/required-server-files.json'), 'utf8'),
  ).config

  process.env.NODE_ENV = 'test'
  runtimeModule = await import('../tests/int/local-runtime.ts')
  await runtimeModule.startLocalIntegrationRuntime()
  runtime = runtimeModule.localIntegrationRuntime()
  appPair = await generateKeyPair('RS256', { extractable: true })
  runtime.fixture.jwks.keys.push({
    ...(await exportJWK(appPair.publicKey)),
    kid: appKid,
    alg: 'RS256',
    use: 'sig',
  })
  const syntheticFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = urlOf(input)
    const provider =
      url.href === appEndpoint ? 'app-check' : url.href === idEndpoint ? 'id-token' : undefined
    if (provider) {
      providerRequests.push(provider)
      assert.equal(init?.method, 'GET')
      assert.equal(new Headers(init?.headers).get('Accept'), 'application/json')
      assert.equal(new Headers(init?.headers).has('Authorization'), false)
      assert.equal(new Headers(init?.headers).has('X-Firebase-AppCheck'), false)
      assert.equal(init?.redirect, 'manual')
      if (outage === provider)
        return Response.json({ error: 'synthetic-key-outage' }, { status: 503 })
      const response = await syntheticFetch(input, init)
      const responseHeaders = new Headers(response.headers)
      // Known keys revalidate on every request, so outages are tested without stale-key acceptance.
      responseHeaders.set('Cache-Control', 'no-store')
      return new Response(response.body, { status: response.status, headers: responseHeaders })
    }
    if (url.href === 'https://telemetry.payloadcms.com/events') {
      blockedTelemetryRequests++
      throw new Error('HTTP smoke blocks Payload telemetry')
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      blockedExternalRequests.push(url.origin)
      throw new Error('HTTP smoke prohibits external fetches')
    }
    return syntheticFetch(input, init)
  }

  const { getPayload } = await import('payload')
  const { default: config } = await import('../src/payload.config.ts')
  // Use a distinct cache key: production REST initializes its own Payload instance.
  seedPayload = await getPayload({ config, key: 'http-smoke-seed' })
  runtimeModule.registerIntegrationPayload(seedPayload)
  const admin = await seedPayload.create({
    collection: 'users',
    data: { email: adminEmail, password: adminPassword },
  })
  seededAdminId = admin.id
  const media = await seedPayload.create({
    collection: 'media',
    data: { alt: 'Synthetic public media fixture' },
    file: {
      data: Buffer.from(mediaBody),
      mimetype: 'text/plain',
      name: 'public-fixture.txt',
      size: Buffer.byteLength(mediaBody),
    },
  })
  mediaFilename = media.filename
  const { initializeClientSecuritySchema } = await import('../src/client-security/initialize.ts')
  const { createClientSecurityStore } = await import('../src/client-security/store.ts')
  const { digestClientSecurityConfiguration } = await import('../src/client-security/schema.ts')
  await initializeClientSecuritySchema(runtime.platform.env.D1)
  securityStore = createClientSecurityStore(runtime.platform.env.D1)
  digestSecurityConfiguration = digestClientSecurityConfiguration
  enabledConfiguration = {
    schemaVersion: 1,
    firebase: {
      enabled: true,
      projectId: runtime.env.FIREBASE_PROJECT_ID,
      projectNumber: runtime.env.FIREBASE_PROJECT_NUMBER,
      appIds: runtime.env.FIREBASE_APP_IDS.split(','),
    },
    limits: { windowSeconds: 60, uid: 1000, ip: 1000, global: 1000 },
  }
  globalThis[Symbol.for('__cloudflare-context__')].cf = { colo: 'LOCAL' }
  await seedPayload.destroy()
  seedPayload = undefined

  process.env.NODE_ENV = 'production'
  const next = (await import('next')).default
  // Reuse the serialized config shipped with this build. Loading next.config.ts again
  // could initialize dev bindings and overwrite the isolated Cloudflare context.
  app = next({ customServer: false, dev: false, dir: root, conf: builtConfig })
  await app.prepare()
  assert.equal(globalThis[Symbol.for('__cloudflare-context__')].env, runtime.env)
  assert.equal(globalThis[Symbol.for('__cloudflare-context__')].cf.colo, 'LOCAL')
  const handler = app.getRequestHandler()
  server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise((resolveListening, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListening)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`

  await expectClient(
    'real-http-default-disabled-store-ignores-enabled-environment',
    503,
    {},
    'firebase_client_disabled',
  )
  await saveSecurityConfiguration(enabledConfiguration)
  await expectClient('real-http-valid-signed-client', 200)
  for (const provider of ['app', 'id']) {
    await test(`real-http-${provider}-unknown-kid-cooldown-with-no-store`, async (send) => {
      const value = await headers(
        provider === 'app'
          ? { appHeader: { kid: 'unpublished-app-key' } }
          : { idHeader: { kid: 'unpublished-id-key' } },
      )
      const before = providerRequests.filter(
        (item) => item === (provider === 'app' ? 'app-check' : 'id-token'),
      ).length
      const result = await send('/api/client/v1/me', { headers: value })
      assert.equal(result.response.status, 401)
      assert.deepEqual(result.json, { error: 'firebase_credentials_invalid' })
      privateHeaders(result.response, 401)
      assert.equal(
        providerRequests.filter((item) => item === (provider === 'app' ? 'app-check' : 'id-token'))
          .length,
        before,
      )
      return { missingKeyCatalogRequests: 0, cacheControl: 'no-store' }
    })
  }
  await expectClient('real-http-query-owner-and-role-ignored', 200, {
    path: '/api/client/v1/me?uid=forged-owner&role=admin',
    idClaims: { id: seededAdminId, collection: 'users', role: 'admin' },
  })
  const spoofedOrigin = await headers()
  spoofedOrigin.set('Origin', 'https://spoofed.fixture.invalid')
  await expectClient('real-http-native-origin-does-not-grant-or-revoke-identity', 200, {
    headers: spoofedOrigin,
  })
  await expectClient('real-http-head-still-authenticates', 200, { method: 'HEAD' })
  await expectClient(
    'real-http-no-credentials',
    401,
    { headers: new Headers() },
    'firebase_credentials_missing',
  )
  await expectClient(
    'real-http-head-without-credentials',
    401,
    { method: 'HEAD', headers: new Headers() },
    'firebase_credentials_missing',
  )
  for (const missing of ['Authorization', 'X-Firebase-AppCheck']) {
    const value = await headers()
    value.delete(missing)
    await expectClient(
      `real-http-missing-${missing.toLowerCase()}`,
      401,
      { headers: value },
      'firebase_credentials_missing',
    )
  }
  for (const authorization of [
    'bearer fixture',
    'Bearer  fixture',
    'Bearer fixture extra',
    'Basic fixture',
  ]) {
    const value = await headers()
    value.set('Authorization', authorization)
    await expectClient(
      `real-http-invalid-authorization-${authorization.split(' ')[0]}-${authorization.length}`,
      401,
      { headers: value },
    )
  }
  for (const [name, options] of [
    [
      'wrong-app-project',
      { appClaims: { iss: 'https://firebaseappcheck.googleapis.com/987654321' } },
    ],
    ['wrong-app-audience', { appClaims: { aud: ['projects/987654321'] } }],
    ['unlisted-app', { appClaims: { sub: '1:123456789:android:unlisted' } }],
    ['wrong-id-project', { idClaims: { aud: 'another-project' } }],
    ['wrong-id-issuer', { idClaims: { iss: 'https://securetoken.google.com/another-project' } }],
    ['array-id-audience', { idClaims: { aud: [runtime.env.FIREBASE_PROJECT_ID] } }],
    ['empty-uid', { idClaims: { sub: '' } }],
    ['oversized-uid', { idClaims: { sub: 'x'.repeat(129) } }],
    ['whitespace-uid', { idClaims: { sub: ' forged-uid' } }],
    ['control-character-uid', { idClaims: { sub: 'uid\nforged' } }],
    ['wrong-provider', { idClaims: { firebase: { sign_in_provider: 'password' } } }],
    ['missing-auth-time', { idClaims: { auth_time: undefined } }],
    ['future-auth-time', { idClaims: { auth_time: Math.floor(Date.now() / 1000) + 3600 } }],
    ['nonnumeric-issued-at', { idClaims: { iat: '123' } }],
    ['nonnumeric-app-issued-at', { appClaims: { iat: '123' } }],
    ['nonnumeric-app-expiry', { appClaims: { exp: '123' } }],
    ['auth-time-after-issuance', { idClaims: { auth_time: Math.floor(Date.now() / 1000) - 1 } }],
    ['expired-app', { appClaims: { exp: Math.floor(Date.now() / 1000) - 1 } }],
    ['expired-id', { idClaims: { exp: Math.floor(Date.now() / 1000) - 1 } }],
    ['future-app-iat', { appClaims: { iat: Math.floor(Date.now() / 1000) + 3600 } }],
    ['wrong-app-typ', { appHeader: { typ: 'id-token' } }],
    ['unsupported-app-alg', { appHeader: { alg: 'HS256' } }],
    ['unsupported-id-alg', { idHeader: { alg: 'HS256' } }],
    ['token-controlled-key-url', { appHeader: { jku: 'https://attacker.fixture.invalid/jwks' } }],
  ])
    await expectClient(`real-http-${name}`, 401, options)
  for (const credential of ['X-Firebase-AppCheck', 'Authorization']) {
    const value = await headers()
    const token = value.get(credential)
    value.set(
      credential,
      credential === 'Authorization'
        ? `Bearer ${mutateSignature(token.slice(7))}`
        : mutateSignature(token),
    )
    await expectClient(`real-http-invalid-signature-${credential.toLowerCase()}`, 401, {
      headers: value,
    })
  }

  const disabledConfiguration = {
    ...enabledConfiguration,
    firebase: { ...enabledConfiguration.firebase, enabled: false },
  }
  try {
    await saveSecurityConfiguration(disabledConfiguration)
    await expectClient('real-http-disabled-config', 503, {}, 'firebase_client_disabled')
    await saveSecurityConfiguration(enabledConfiguration)
    const snapshot = await securityStore.read()
    const corruptConfiguration = {
      ...enabledConfiguration,
      firebase: { ...enabledConfiguration.firebase, projectId: '' },
    }
    try {
      await runtime.platform.env.D1.prepare(
        'UPDATE client_security_versions SET configuration = ? WHERE revision = ?',
      )
        .bind(JSON.stringify(corruptConfiguration), snapshot.revision)
        .run()
      await expectClient('real-http-corrupt-managed-config', 503, {}, 'client_security_corrupt')
    } finally {
      await runtime.platform.env.D1.prepare(
        'UPDATE client_security_versions SET configuration = ? WHERE revision = ?',
      )
        .bind(JSON.stringify(enabledConfiguration), snapshot.revision)
        .run()
    }
  } finally {
    await saveSecurityConfiguration(enabledConfiguration)
  }
  for (const provider of ['app-check', 'id-token']) {
    try {
      outage = provider
      await expectClient(`real-http-${provider}-key-outage`, 503, {}, 'firebase_keys_unavailable')
      await expectClient(
        `real-http-${provider}-key-outage-backoff`,
        503,
        {},
        'firebase_keys_unavailable',
      )
    } finally {
      outage = undefined
    }
    await delay(5100)
    await expectClient(`real-http-${provider}-key-outage-recovers`, 200)
  }
  const environmentEnabled = runtime.env.FIREBASE_CLIENT_ENABLED
  try {
    runtime.env.FIREBASE_CLIENT_ENABLED = 'false'
    await expectClient('real-http-managed-store-remains-authoritative-over-environment', 200)
  } finally {
    runtime.env.FIREBASE_CLIENT_ENABLED = environmentEnabled
  }
  await expectClient(
    'real-http-invalid-trusted-ip-fails-closed',
    503,
    { ip: 'forged-ip' },
    'client_security_unavailable',
  )
  for (const dimension of ['uid', 'ip', 'global']) {
    await saveSecurityConfiguration({
      ...enabledConfiguration,
      limits: { ...enabledConfiguration.limits, [dimension]: 1 },
    })
    await runtime.platform.env.D1.prepare('DELETE FROM client_security_counters').run()
    await expectClient(`real-http-${dimension}-rate-limit-first-request-admitted`, 200)
    await expectClient(
      `real-http-${dimension}-rate-limit-second-request-denied`,
      429,
      {
        idClaims: dimension === 'uid' ? {} : { sub: 'http-smoke-other-anonymous-uid' },
        ip: dimension === 'ip' ? '203.0.113.10' : '203.0.113.11',
      },
      'client_security_rate_limited',
    )
  }
  await runtime.platform.env.D1.prepare('DELETE FROM client_security_counters').run()
  await saveSecurityConfiguration(enabledConfiguration)
  await test('real-http-post-cannot-call-get-or-supply-owner', async (send) => {
    for (const value of [new Headers(), await headers()]) {
      value.set('Content-Type', 'application/json')
      const result = await send('/api/client/v1/me', {
        method: 'POST',
        headers: value,
        body: JSON.stringify({ uid: 'forged-owner', role: 'admin' }),
      })
      assert.equal(result.response.status, 405)
    }
  })
  await test('real-http-options-is-method-discovery-only', async (send) => {
    const result = await send('/api/client/v1/me', { method: 'OPTIONS' })
    assert.equal(result.response.status, 204)
    const methods = result.response.headers
      .get('Allow')
      ?.split(',')
      .map((value) => value.trim())
      .sort()
    assert.deepEqual(methods, ['GET', 'HEAD', 'OPTIONS'])
    assert.equal(result.text, '')
  })

  await test('real-http-public-media-list-preserved', async (send) => {
    const list = await send('/api/media')
    assert.equal(list.response.status, 200)
    assert.equal(list.json.totalDocs, 1)
    assert.equal(list.json.docs[0].filename, mediaFilename)
  })
  await test('real-http-public-r2-file-download-local-runtime-limit', async (send) => {
    const file = await send(`/api/media/file/${encodeURIComponent(mediaFilename)}`)
    if (file.response.status === 200) {
      assert.equal(file.text, mediaBody)
      return { observedHttpStatus: 200 }
    }
    assert.equal(file.response.status, 500)
    const stored = await runtime.platform.env.R2.get(mediaFilename)
    assert.ok(stored)
    assert.equal(await stored.text(), mediaBody)
    let metadataFailure
    try {
      // The installed production adapter calls this native method. Miniflare's
      // Node proxy cannot serialize Node Headers into its Workers object.
      await stored.writeHttpMetadata(new Headers())
    } catch (error) {
      metadataFailure = error.name
    }
    assert.ok(metadataFailure)
    return {
      status: 'NOT_RUN',
      observedHttpStatus: file.response.status,
      realLocalR2BytesVerified: true,
      nativeMetadataMethodFailure: metadataFailure,
      scope:
        'Production file-download acceptance is not verified: the installed R2 adapter uses native writeHttpMetadata, which rejects Node Headers through the Miniflare proxy. Real local R2 bytes are verified. Public metadata passed separately; development adapter download behavior is covered by integration tests.',
    }
  })
  await test('real-http-anonymous-admin-user-list-and-mutations-denied', async (send) => {
    const me = await send('/api/users/me')
    assert.equal(me.response.status, 200)
    assert.equal(me.json.user, null)
    assert.equal((await send('/api/users')).response.status, 403)
    assert.equal(
      (
        await send('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'forged@fixture.invalid', password: adminPassword }),
        })
      ).response.status,
      403,
    )
    assert.equal(
      (
        await send('/api/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alt: 'forged media' }),
        })
      ).response.status,
      403,
    )
  })
  await test('real-http-firebase-never-authenticates-payload-admin', async (send) => {
    const value = await headers({
      idClaims: { id: seededAdminId, collection: 'users', role: 'admin', sid: 'forged-session' },
    })
    const me = await send('/api/users/me', { headers: value })
    assert.equal(me.response.status, 200)
    assert.equal(me.json.user, null)
    assert.equal((await send('/api/users', { headers: value })).response.status, 403)
    value.set('Content-Type', 'application/json')
    assert.equal(
      (
        await send('/api/users', {
          method: 'POST',
          headers: value,
          body: JSON.stringify({ email: 'forged@fixture.invalid', password: adminPassword }),
        })
      ).response.status,
      403,
    )
  })
  await test('real-http-payload-admin-login-and-bearer-session-preserved', async (send) => {
    const login = await send('/api/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    })
    assert.equal(login.response.status, 200)
    assert.equal(login.json.user.id, seededAdminId)
    assert.equal(typeof login.json.token, 'string')
    adminToken = login.json.token
    const setCookie = login.response.headers.get('Set-Cookie')
    assert.ok(setCookie?.includes('payload-token='))
    assert.match(setCookie, /(?:^|;)\s*HttpOnly(?:=true)?(?:;|$)/i)
    assert.match(setCookie, /(?:^|;)\s*SameSite=Lax(?:;|$)/i)
    adminCookie = setCookie.split(';')[0]
    const list = await send('/api/users', { headers: { Authorization: `Bearer ${adminToken}` } })
    assert.equal(list.response.status, 200)
    assert.equal(list.json.totalDocs, 1)
    assert.equal(list.json.docs[0].id, seededAdminId)
    return { cookieFlags: { httpOnly: true, sameSite: 'Lax' } }
  })
  await test('real-http-settings-read-denies-ordinary-admin', async (send) => {
    for (const value of [{ Authorization: `Bearer ${adminToken}` }, { Cookie: adminCookie }]) {
      const result = await send('/api/admin/client-security', { headers: value })
      assert.equal(result.response.status, 403)
      assert.deepEqual(result.json, { error: 'client_security_owner_required' })
      ownerHeaders(result.response)
    }
  })
  await test('real-http-settings-read-denies-anonymous-and-firebase', async (send) => {
    for (const value of [
      new Headers(),
      await headers({ idClaims: { role: 'owner', id: seededAdminId, collection: 'users' } }),
    ]) {
      const result = await send('/api/admin/client-security', { headers: value })
      assert.equal(result.response.status, 403)
      assert.deepEqual(result.json, { error: 'client_security_owner_required' })
      ownerHeaders(result.response)
    }
  })
  await test('real-http-custom-admin-page-denies-ordinary-admin', async (send) => {
    const result = await send('/admin/client-security', { headers: { Cookie: adminCookie } })
    assert.equal(result.response.status, 200)
    assert.match(result.text, /<h1[^>]*>Access denied<\/h1>/)
    assert.equal(/<h1[^>]*>Client security<\/h1>/.test(result.text), false)
    return { scope: 'Compiled server-rendered owner boundary; no browser interaction exercised.' }
  })
  const adminOnNative = await headers()
  adminOnNative.set('Authorization', `Bearer ${adminToken}`)
  await expectClient('real-http-payload-hs-session-cannot-authenticate-native-client', 401, {
    headers: adminOnNative,
  })
  await expectClient(
    'real-http-admin-cookie-alone-cannot-authenticate-native-client',
    401,
    {
      headers: new Headers({ Cookie: adminCookie }),
    },
    'firebase_credentials_missing',
  )
  await test('real-http-cookie-origin-policy-matches-unconfigured-baseline', async (send) => {
    const list = await send('/api/users', {
      headers: { Cookie: adminCookie, Origin: 'https://untrusted.fixture.invalid' },
    })
    assert.equal(list.response.status, 200)
    assert.equal(list.json.docs[0].id, seededAdminId)
    const value = await headers()
    value.set('Cookie', adminCookie)
    const firebasePriority = await send('/api/users/me', { headers: value })
    assert.equal(firebasePriority.response.status, 200)
    assert.equal(firebasePriority.json.user, null)
    return {
      scope:
        'Template csrf list is empty; Payload accepts signed cookies with arbitrary Origin. No origin allowlist was added. Firebase bearer tokens still do not grant admin access.',
      untrustedOriginCookieStatus: list.response.status,
    }
  })

  // Ephemeral SQL bootstrap creates the first owner without weakening production role hooks.
  const bootstrap = await runtime.platform.env.D1.prepare(
    "UPDATE users SET role = 'owner' WHERE id = ? AND role = 'admin' AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner')",
  )
    .bind(seededAdminId)
    .run()
  assert.equal(bootstrap.meta.changes, 1)
  await test('real-http-settings-read-allows-stored-owner-with-existing-session', async (send) => {
    const result = await send('/api/admin/client-security', { headers: { Cookie: adminCookie } })
    assert.equal(result.response.status, 200)
    assert.deepEqual(result.json.snapshot.configuration, enabledConfiguration)
    assert.equal(result.json.readiness.ready, true)
    assert.ok(result.json.history.length > 0)
    ownerHeaders(result.response)
    return {
      scope: 'Actual Payload session plus current D1 role; no injected owner authenticator.',
    }
  })
  await test('real-http-custom-admin-page-renders-for-stored-owner', async (send) => {
    const result = await send('/admin/client-security', { headers: { Cookie: adminCookie } })
    assert.equal(result.response.status, 200)
    assert.match(result.text, /<h1[^>]*>Client security<\/h1>/)
    assert.match(result.text, /Loading saved settings/)
    assert.equal(/<h1[^>]*>Access denied<\/h1>/.test(result.text), false)
    return {
      scope: 'Compiled custom admin route and server render; no browser UI interaction exercised.',
    }
  })

  assert.deepEqual(
    await hashes(sourceFiles),
    sourceHashes,
    'source changed during HTTP verification',
  )
  assert.deepEqual(await hashes(artifacts), buildHashes, 'build changed during HTTP verification')
  assert.equal(blockedExternalRequests.length, 0, 'app attempted unexpected external fetches')
} catch (error) {
  failure = error
} finally {
  try {
    if (server) {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    }
    await app?.close()
  } catch {
    failure ??= new Error('HTTP smoke server cleanup failed')
  }
  try {
    const productionPayload = globalThis._payload?.get('default')?.payload
    if (productionPayload) runtimeModule?.registerIntegrationPayload(productionPayload)
    await runtimeModule?.disposeLocalIntegrationRuntime()
  } catch {
    failure ??= new Error('HTTP smoke local storage cleanup failed')
  } finally {
    globalThis.fetch = originalFetch
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    await unregister()
  }
}

const report = {
  status: failure
    ? 'FAIL'
    : observations.some((item) => item.status === 'NOT_RUN')
      ? 'PASS_WITH_LIMITATIONS'
      : 'PASS',
  checks: observations.length,
  passedChecks: observations.filter((item) => item.status === 'PASS').length,
  notRunChecks: observations.filter((item) => item.status === 'NOT_RUN').map((item) => item.name),
  verifiedRequests: observations.reduce((sum, item) => sum + item.requests.length, 0),
  failedCheck: observations.find((item) => item.status === 'FAIL')?.name,
  failedChecks: observations.filter((item) => item.status === 'FAIL').map((item) => item.name),
  setupOrCleanupFailure: Boolean(failure && !observations.some((item) => item.status === 'FAIL')),
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  sourceHashes,
  dependencyLockSha256: sourceHashes?.['pnpm-lock.yaml'],
  buildId,
  buildHashes,
  nodeVersion: process.version,
  elapsedMs: Math.round(performance.now() - start),
  server: 'compiled Next.js production HTTP server, ephemeral loopback port',
  storage:
    'real isolated local D1 and R2, seeded under NODE_ENV=test; production REST initializes a separate Payload instance; managed client schema initialized and reviewed synthetic configuration saved through the real store',
  trustedRequestScope:
    'Loopback Node server simulates genuine Cloudflare cf.colo metadata as colo LOCAL and a CF-Connecting-IP header; deployed edge header provenance is not exercised here.',
  publicConfig: 'synthetic fixture project/app identifiers only; no environment files loaded',
  realProviderRequests: 0,
  paidAiCalls: 0,
  syntheticProviderRequests: providerRequests.length,
  blockedExternalRequests: blockedExternalRequests.length,
  blockedTelemetryRequests,
  blockedTelemetryEndpoints:
    blockedTelemetryRequests > 0 ? ['https://telemetry.payloadcms.com/events'] : [],
  realFirebaseProviderFlow: 'NOT_RUN',
  csrfLimitation:
    'The template has an empty Payload csrf list, so signed cookie Origin is unrestricted. Existing configured-allowlist behavior is separately checked by unit fixtures. SameSite=Lax/HttpOnly cookie flags are checked here.',
  observations,
}
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
if (failure) {
  console.error(failure.message)
  process.exitCode = 1
} else {
  console.log(
    `PASS ${report.passedChecks} compiled Next.js HTTP checks / ${report.verifiedRequests} requests; ${report.notRunChecks.length} NOT_RUN; zero external provider or AI calls.`,
  )
}
