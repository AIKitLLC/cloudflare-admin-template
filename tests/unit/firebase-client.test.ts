import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createFirebaseClientAuthenticator,
  FIREBASE_APP_CHECK_JWKS_ENDPOINT,
  FIREBASE_ID_CERTIFICATES_ENDPOINT,
  FirebaseAuthError,
  readFirebaseClientConfig,
  type FirebaseClientEnv,
} from '../../src/auth/firebase-client'

const NOW = Date.parse('2026-10-13T16:00:00.000Z'),
  UID = 'synthetic-anonymous-uid'
const PROJECT_ID = 'template-fixture',
  PROJECT_NUMBER = '123456789',
  APP_ID = `1:${PROJECT_NUMBER}:android:0123456789abcdef`
const env: FirebaseClientEnv = {
  FIREBASE_CLIENT_ENABLED: 'true',
  FIREBASE_PROJECT_ID: PROJECT_ID,
  FIREBASE_PROJECT_NUMBER: PROJECT_NUMBER,
  FIREBASE_APP_IDS: APP_ID,
}
const keys = [0, 1].map(
  () =>
    crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    ) as Promise<CryptoKeyPair>,
)
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const bytes = (value: string) => new TextEncoder().encode(value)
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    value.set(part, offset)
    offset += part.length
  }
  return value
}
function der(tag: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat(...parts),
    size = body.length
  const length = size < 128 ? [size] : size < 256 ? [0x81, size] : [0x82, size >> 8, size & 255]
  return concat(new Uint8Array([tag, ...length]), body)
}
async function certificate(index = 0) {
  const pair = await keys[index],
    algorithm = der(
      0x30,
      der(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 0x0b])),
      der(5),
    )
  const name = der(
    0x30,
    der(
      0x31,
      der(0x30, der(6, new Uint8Array([0x55, 4, 3])), der(0x0c, bytes('Synthetic Firebase Test'))),
    ),
  )
  const validity = der(0x30, der(0x17, bytes('260101000000Z')), der(0x17, bytes('270101000000Z')))
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  const tbs = der(
    0x30,
    der(0xa0, der(2, new Uint8Array([2]))),
    der(2, new Uint8Array([index + 1])),
    algorithm,
    name,
    validity,
    name,
    publicKey,
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, tbs),
  )
  const encoded = Buffer.from(
    der(0x30, tbs, algorithm, der(3, new Uint8Array([0]), signature)),
  ).toString('base64')
  return `-----BEGIN CERTIFICATE-----\n${encoded.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`
}
const certificates = [certificate(0), certificate(1)]
async function jwk(index = 0) {
  return {
    ...(await crypto.subtle.exportKey('jwk', (await keys[index]).publicKey)),
    alg: 'RS256',
    use: 'sig',
    kid: `key-${index}`,
  }
}
function appClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: `https://firebaseappcheck.googleapis.com/${PROJECT_NUMBER}`,
    aud: [`projects/${PROJECT_NUMBER}`],
    sub: APP_ID,
    iat: NOW / 1000 - 10,
    exp: NOW / 1000 + 3600,
    ...overrides,
  }
}
function idClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: UID,
    iat: NOW / 1000 - 10,
    exp: NOW / 1000 + 3600,
    auth_time: NOW / 1000 - 30,
    firebase: { sign_in_provider: 'anonymous' },
    ...overrides,
  }
}
async function signedToken(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
  index = 0,
) {
  const input = `${encode({ alg: 'RS256', kid: `key-${index}`, typ: 'JWT', ...header })}.${encode(claims)}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    (await keys[index]).privateKey,
    bytes(input),
  )
  return `${input}.${Buffer.from(signature).toString('base64url')}`
}
async function credentials(
  app: Record<string, unknown> = {},
  id: Record<string, unknown> = {},
  appHeader: Record<string, unknown> = {},
  idHeader: Record<string, unknown> = {},
  index = 0,
) {
  return {
    app: await signedToken(appClaims(app), appHeader, index),
    id: await signedToken(idClaims(id), idHeader, index),
  }
}
function request(tokens: { app: string; id: string }, headers: Record<string, string> = {}) {
  return new Request('https://worker.example.test/api/client/v1/session', {
    method: 'POST',
    headers: {
      'X-Firebase-AppCheck': tokens.app,
      Authorization: `Bearer ${tokens.id}`,
      ...headers,
    },
    body: JSON.stringify({}),
  })
}
function json(value: unknown, headers: Record<string, string> = {}, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600', ...headers },
  })
}
type KeyResponse = (url: string) => Promise<Response>
function fixture(response?: KeyResponse, timeoutMs?: number) {
  let now = NOW,
    index = 0
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    assert.ok(
      [FIREBASE_APP_CHECK_JWKS_ENDPOINT, FIREBASE_ID_CERTIFICATES_ENDPOINT].includes(url),
      'only fixed provider URLs',
    )
    return response
      ? response(url)
      : url === FIREBASE_APP_CHECK_JWKS_ENDPOINT
        ? json({ keys: [await jwk(index)] })
        : json({ [`key-${index}`]: await certificates[index] })
  }
  const authenticate = createFirebaseClientAuthenticator({ fetcher, nowMs: () => now, timeoutMs })
  return {
    calls,
    authenticate,
    advance: (ms: number) => {
      now += ms
    },
    rotate: () => {
      index = 1
    },
  }
}
async function rejects(
  promise: Promise<unknown>,
  status = 401,
  reason = 'firebase_credentials_invalid',
) {
  await assert.rejects(
    promise,
    (error) =>
      error instanceof FirebaseAuthError &&
      error.status === status &&
      error.reason === reason &&
      error.message === reason &&
      !error.message.includes(UID),
  )
}

test('verified independent app and anonymous identity tokens return only a trusted principal', async () => {
  const f = fixture(),
    tokens = await credentials()
  assert.deepEqual(await f.authenticate(request(tokens), env), {
    uid: UID,
    appId: APP_ID,
    projectId: PROJECT_ID,
  })
  assert.notEqual(UID, APP_ID)
  assert.equal(f.calls.length, 2)
  for (const call of f.calls) {
    assert.equal(call.init?.redirect, 'manual')
    assert.equal(call.init?.method, 'GET')
    assert.ok(call.init?.signal)
    assert.deepEqual(call.init?.headers, { Accept: 'application/json' })
    assert.equal(JSON.stringify(call).includes(tokens.id), false)
    assert.equal(JSON.stringify(call).includes(tokens.app), false)
  }
  assert.equal(Object.isFrozen(await f.authenticate(request(tokens), env)), true)
})
test('request body and cookies cannot supply authentication, UID, or provider configuration', async () => {
  const f = fixture(),
    tokens = await credentials()
  const forged = new Request(request(tokens), {
    headers: { Cookie: 'uid=owner' },
    body: JSON.stringify({ uid: 'owner', question: 'test', ...env }),
  })
  await rejects(f.authenticate(forged, env), 401, 'firebase_credentials_missing')
  assert.equal(f.calls.length, 0)
})
for (const key of Object.keys(env) as (keyof FirebaseClientEnv)[])
  test(`missing ${key} cannot activate client authentication`, async () => {
    const f = fixture()
    await rejects(
      f.authenticate(request(await credentials()), { ...env, [key]: undefined }),
      503,
      key === 'FIREBASE_CLIENT_ENABLED'
        ? 'firebase_client_disabled'
        : 'firebase_client_misconfigured',
    )
    assert.equal(f.calls.length, 0)
  })
for (const [name, value] of Object.entries({
  falseFlag: { FIREBASE_CLIENT_ENABLED: 'false' },
  booleanFlag: { FIREBASE_CLIENT_ENABLED: true },
  badId: { FIREBASE_PROJECT_ID: 'https://attacker.test' },
  uppercaseId: { FIREBASE_PROJECT_ID: 'Fixture' },
  numericId: { FIREBASE_PROJECT_ID: 123456 },
  badNumber: { FIREBASE_PROJECT_NUMBER: '0123456789' },
  badApp: { FIREBASE_APP_IDS: 'https://attacker.test' },
  wrongProjectApp: { FIREBASE_APP_IDS: '1:987654321:android:0123456789abcdef' },
  emptyApp: { FIREBASE_APP_IDS: '' },
  duplicateApp: { FIREBASE_APP_IDS: `${APP_ID},${APP_ID}` },
  trailingApp: { FIREBASE_APP_IDS: `${APP_ID},` },
})) {
  test(`configuration rejects ${name}`, () =>
    assert.equal(readFirebaseClientConfig({ ...env, ...value } as FirebaseClientEnv), null))
}
test('allowlist accepts explicit multiple Firebase app IDs, but cannot be changed by a request', () => {
  const config = readFirebaseClientConfig({
    ...env,
    FIREBASE_APP_IDS: `${APP_ID}, 1:${PROJECT_NUMBER}:android:abcdef`,
  })!
  assert.equal(config.appIds.length, 2)
  assert.equal(Object.isFrozen(config.appIds), true)
})
for (const header of ['Authorization', 'X-Firebase-AppCheck'])
  test(`missing ${header} returns 401 without fetching keys`, async () => {
    const f = fixture(),
      r = request(await credentials())
    r.headers.delete(header)
    await rejects(f.authenticate(r, env), 401, 'firebase_credentials_missing')
    assert.equal(f.calls.length, 0)
  })
for (const value of [
  '',
  'Basic foo',
  'bearer foo',
  'Bearer',
  'Bearer  one',
  'Bearer one two',
  'Bearer token, Bearer token',
]) {
  test(`Authorization rejects non-contract value ${JSON.stringify(value)}`, async () => {
    const f = fixture()
    await rejects(
      f.authenticate(request(await credentials(), { Authorization: value }), env),
      401,
      value ? 'firebase_credentials_invalid' : 'firebase_credentials_missing',
    )
    assert.equal(f.calls.length, 0)
  })
}
for (const value of ['not-a-jwt', 'a.b', 'a.b.c.d', 'a.b.c=', 'a..c', 'x'.repeat(16 * 1024 + 1)]) {
  test(`malformed App Check token ${value.length} bytes cannot fetch keys`, async () => {
    const f = fixture()
    await rejects(f.authenticate(request({ ...(await credentials()), app: value }), env))
    assert.equal(f.calls.length, 0)
  })
}
for (const kind of ['app', 'id'] as const) {
  for (const [name, header] of Object.entries({
    none: { alg: 'none' },
    hmac: { alg: 'HS256' },
    rsaPss: { alg: 'PS256' },
    emptyKid: { kid: '' },
    missingKid: { kid: undefined },
    URLKid: { kid: 'https://attacker.test' },
    jku: { jku: 'https://attacker.test/jwks' },
    embedded: { jwk: { kty: 'RSA' } },
    certificateURL: { x5u: 'https://attacker.test' },
    certificateHeader: { x5c: ['forged'] },
    critical: { crit: ['custom'] },
  })) {
    test(`${kind} rejects ${name} header before fetching any keys`, async () => {
      const f = fixture(),
        tokens =
          kind === 'app' ? await credentials({}, {}, header) : await credentials({}, {}, {}, header)
      await rejects(f.authenticate(request(tokens), env))
      assert.equal(f.calls.length, 0)
    })
  }
}
for (const typ of ['jwt', 'JOSE', undefined])
  test(`App Check requires exact JWT type ${String(typ)}`, async () => {
    const f = fixture()
    await rejects(f.authenticate(request(await credentials({}, {}, { typ })), env))
    assert.equal(f.calls.length, 0)
  })
for (const [name, claims] of Object.entries({
  wrongIssuer: { iss: `https://firebaseappcheck.googleapis.com/${PROJECT_ID}` },
  missingIssuer: { iss: undefined },
  missingAudience: { aud: undefined },
  wrongAudience: { aud: PROJECT_ID },
  substringAudience: { aud: `prefix-projects/${PROJECT_NUMBER}-suffix` },
  foreignApp: { sub: `1:${PROJECT_NUMBER}:android:anotherapp` },
  missingSub: { sub: undefined },
  expired: { exp: NOW / 1000 },
  missingExpiry: { exp: undefined },
  futureIssued: { iat: NOW / 1000 + 1 },
  missingIssued: { iat: undefined },
  stringIssued: { iat: String(NOW / 1000) },
  fractionalIssued: { iat: NOW / 1000 - 0.5 },
  negativeIssued: { iat: -1 },
  invalidExpiry: { exp: NOW / 1000 + 0.5 },
  futureNbf: { nbf: NOW / 1000 + 1 },
})) {
  test(`App Check rejects signed ${name} claim`, async () => {
    const f = fixture()
    await rejects(f.authenticate(request(await credentials(claims)), env))
    assert.equal(f.calls.filter((call) => call.url === FIREBASE_ID_CERTIFICATES_ENDPOINT).length, 0)
  })
}
test('App Check supports a string audience or an audience array with an exact project match', async () => {
  for (const aud of [
    `projects/${PROJECT_NUMBER}`,
    ['another-audience', `projects/${PROJECT_NUMBER}`],
  ]) {
    const f = fixture()
    assert.equal((await f.authenticate(request(await credentials({ aud })), env)).uid, UID)
  }
})
for (const [name, claims] of Object.entries({
  wrongIssuer: { iss: `https://securetoken.google.com/${PROJECT_NUMBER}` },
  missingIssuer: { iss: undefined },
  missingAudience: { aud: undefined },
  wrongAudience: { aud: PROJECT_NUMBER },
  arrayAudience: { aud: [PROJECT_ID] },
  missingSubject: { sub: undefined },
  emptySubject: { sub: '' },
  bigSubject: { sub: 'x'.repeat(129) },
  controlSubject: { sub: 'uid\u0000' },
  whitespaceSubject: { sub: ' uid ' },
  expired: { exp: NOW / 1000 },
  missingExpiry: { exp: undefined },
  futureIssued: { iat: NOW / 1000 + 1 },
  missingIssued: { iat: undefined },
  stringIssued: { iat: String(NOW / 1000) },
  fractionalIssued: { iat: NOW / 1000 - 0.5 },
  negativeIssued: { iat: -1 },
  fractionalExpiry: { exp: NOW / 1000 + 0.5 },
  stringExpiry: { exp: String(NOW / 1000 + 3600) },
  unsafeExpiry: { exp: Number.MAX_SAFE_INTEGER + 1 },
  futureNbf: { nbf: NOW / 1000 + 1 },
  missingAuthTime: { auth_time: undefined },
  stringAuthTime: { auth_time: String(NOW / 1000 - 30) },
  futureAuth: { auth_time: NOW / 1000 + 1 },
  authAfterIssued: { auth_time: NOW / 1000 - 9 },
  fractionalAuth: { auth_time: NOW / 1000 - 0.5 },
  negativeAuth: { auth_time: -1 },
  password: { firebase: { sign_in_provider: 'password' } },
  custom: { firebase: { sign_in_provider: 'custom' } },
  noProvider: { firebase: undefined },
  arrayProvider: { firebase: [{ sign_in_provider: 'anonymous' }] },
})) {
  test(`ID token rejects signed ${name} claim`, async () => {
    const f = fixture()
    await rejects(f.authenticate(request(await credentials({}, claims)), env))
  })
}
for (const kind of ['app', 'id'] as const)
  test(`${kind} signature tampering is rejected`, async () => {
    const f = fixture(),
      tokens = await credentials(),
      parts = tokens[kind].split('.')
    parts[1] = encode(
      kind === 'app' ? appClaims({ sub: 'forged-app' }) : idClaims({ sub: 'owner' }),
    )
    tokens[kind] = parts.join('.')
    await rejects(f.authenticate(request(tokens), env))
  })
test('App Check and ID token keys cannot be swapped between trust domains', async () => {
  const f = fixture(async (url) =>
    url === FIREBASE_APP_CHECK_JWKS_ENDPOINT
      ? json({ keys: [await jwk(0)] })
      : json({ 'key-0': await certificates[1] }),
  )
  await rejects(f.authenticate(request(await credentials()), env))
})
test('valid tokens use cached keys and concurrent first requests share each provider fetch', async () => {
  const f = fixture(),
    tokens = await credentials()
  const result = await Promise.all(
    Array.from({ length: 20 }, () => f.authenticate(request(tokens), env)),
  )
  assert.ok(result.every((identity) => identity.uid === UID))
  assert.equal(f.calls.length, 2)
  await f.authenticate(request(tokens), env)
  assert.equal(f.calls.length, 2)
})
test('unknown key cooldown prevents cache-busting, then rotation is fetched and verified', async () => {
  const f = fixture()
  await f.authenticate(request(await credentials()), env)
  f.rotate()
  for (let i = 0; i < 5; i++)
    await rejects(f.authenticate(request(await credentials({}, {}, {}, {}, 1)), env))
  assert.equal(f.calls.length, 2)
  f.advance(30_001)
  assert.equal((await f.authenticate(request(await credentials({}, {}, {}, {}, 1)), env)).uid, UID)
  assert.equal(f.calls.length, 4)
})
for (const kind of ['app', 'id'] as const)
  for (const control of ['no-store', 'max-age=0']) {
    test(`${kind} unknown-key cooldown still applies with ${control} responses`, async () => {
      let rotated = false
      const endpoint =
        kind === 'app' ? FIREBASE_APP_CHECK_JWKS_ENDPOINT : FIREBASE_ID_CERTIFICATES_ENDPOINT
      const f = fixture(async (url) => {
        const index = url === endpoint && rotated ? 1 : 0
        const headers: Record<string, string> = url === endpoint ? { 'Cache-Control': control } : {}
        return url === FIREBASE_APP_CHECK_JWKS_ENDPOINT
          ? json({ keys: [await jwk(index)] }, headers)
          : json({ [`key-${index}`]: await certificates[index] }, headers)
      })
      await f.authenticate(request(await credentials()), env)
      const rotatedTokens = await credentials()
      rotatedTokens[kind] = await signedToken(kind === 'app' ? appClaims() : idClaims(), {}, 1)
      rotated = true
      for (let i = 0; i < 5; i++) await rejects(f.authenticate(request(rotatedTokens), env))
      assert.equal(f.calls.length, 2)
      f.advance(30_001)
      assert.equal((await f.authenticate(request(rotatedTokens), env)).uid, UID)
      assert.equal(f.calls.length, 3)
    })
  }
for (const kind of ['app', 'id'] as const) {
  test(`${kind} cold unknown-key outage remains 503 after failure backoff`, async () => {
    const endpoint =
      kind === 'app' ? FIREBASE_APP_CHECK_JWKS_ENDPOINT : FIREBASE_ID_CERTIFICATES_ENDPOINT
    const f = fixture(async (url) =>
      url === endpoint
        ? json({ private: 'provider-detail' }, {}, 503)
        : url === FIREBASE_APP_CHECK_JWKS_ENDPOINT
          ? json({ keys: [await jwk()] })
          : json({ 'key-0': await certificates[0] }),
    )
    const unknown = await credentials()
    unknown[kind] = await signedToken(kind === 'app' ? appClaims() : idClaims(), {}, 1)
    await rejects(f.authenticate(request(unknown), env), 503, 'firebase_keys_unavailable')
    await rejects(f.authenticate(request(unknown), env), 503, 'firebase_keys_unavailable')
    assert.equal(f.calls.filter((call) => call.url === endpoint).length, 1)
    f.advance(5001)
    await rejects(f.authenticate(request(unknown), env), 503, 'firebase_keys_unavailable')
    assert.equal(f.calls.filter((call) => call.url === endpoint).length, 2)
  })

  test(`${kind} failed warm refresh remains 503 after backoff and recovers only with a successful catalog`, async () => {
    const endpoint =
      kind === 'app' ? FIREBASE_APP_CHECK_JWKS_ENDPOINT : FIREBASE_ID_CERTIFICATES_ENDPOINT
    let outage = false,
      recovered = false
    const f = fixture(async (url) => {
      if (url === endpoint && outage) return json({ private: 'provider-detail' }, {}, 503)
      const index = url === endpoint && recovered ? 1 : 0
      return url === FIREBASE_APP_CHECK_JWKS_ENDPOINT
        ? json(
            { keys: [await jwk(index)] },
            { 'Cache-Control': url === endpoint ? 'max-age=1' : 'max-age=3600' },
          )
        : json(
            { [`key-${index}`]: await certificates[index] },
            { 'Cache-Control': url === endpoint ? 'max-age=1' : 'max-age=3600' },
          )
    })
    const original = await credentials()
    await f.authenticate(request(original), env)
    outage = true
    f.advance(2000)
    await rejects(f.authenticate(request(original), env), 503, 'firebase_keys_unavailable')
    const rotated = await credentials()
    rotated[kind] = await signedToken(kind === 'app' ? appClaims() : idClaims(), {}, 1)
    await rejects(f.authenticate(request(rotated), env), 503, 'firebase_keys_unavailable')
    assert.equal(f.calls.filter((call) => call.url === endpoint).length, 2)
    f.advance(5001)
    await Promise.all(
      Array.from({ length: 8 }, () =>
        rejects(f.authenticate(request(rotated), env), 503, 'firebase_keys_unavailable'),
      ),
    )
    assert.equal(
      f.calls.filter((call) => call.url === endpoint).length,
      3,
      'concurrent retries share one failed refresh and must not establish an unknown-key verdict',
    )
    outage = false
    recovered = true
    await rejects(f.authenticate(request(rotated), env), 503, 'firebase_keys_unavailable')
    assert.equal(f.calls.filter((call) => call.url === endpoint).length, 3)
    f.advance(5001)
    assert.equal((await f.authenticate(request(rotated), env)).uid, UID)
    assert.equal(f.calls.filter((call) => call.url === endpoint).length, 4)
    const absent = await credentials()
    absent[kind] = await signedToken(
      kind === 'app' ? appClaims() : idClaims(),
      { kid: 'absent-after-recovery' },
      1,
    )
    await rejects(f.authenticate(request(absent), env), 401, 'firebase_credentials_invalid')
    assert.equal(
      f.calls.filter((call) => call.url === endpoint).length,
      4,
      'the successful recovered catalog restores bounded unknown-key rejection',
    )
    f.advance(30_001)
    await rejects(f.authenticate(request(absent), env), 401, 'firebase_credentials_invalid')
    assert.equal(
      f.calls.filter((call) => call.url === endpoint).length,
      5,
      'a successful catalog missing the requested key establishes 401 even after an outage',
    )
  })
}

test('expired key cache refreshes without accepting stale keys during an outage', async () => {
  let failed = false
  const f = fixture(async (url) =>
    failed
      ? json({ secret: 'provider-detail-never-returned' }, {}, 503)
      : url === FIREBASE_APP_CHECK_JWKS_ENDPOINT
        ? json({ keys: [await jwk()] }, { 'Cache-Control': 'max-age=1' })
        : json({ 'key-0': await certificates[0] }, { 'Cache-Control': 'max-age=1' }),
  )
  const tokens = await credentials()
  await f.authenticate(request(tokens), env)
  failed = true
  f.advance(1001)
  await rejects(f.authenticate(request(tokens), env), 503, 'firebase_keys_unavailable')
  await rejects(f.authenticate(request(tokens), env), 503, 'firebase_keys_unavailable')
  assert.equal(f.calls.length, 3)
})
test('App Check lifetime caps caching at six hours while ID certificate cache respects max-age', async () => {
  const f = fixture(async (url) =>
    url === FIREBASE_APP_CHECK_JWKS_ENDPOINT
      ? json({ keys: [await jwk()] }, { 'Cache-Control': 'max-age=999999' })
      : json({ 'key-0': await certificates[0] }, { 'Cache-Control': 'max-age=120' }),
  )
  const long = await credentials({ exp: NOW / 1000 + 100_000 }, { exp: NOW / 1000 + 100_000 })
  await f.authenticate(request(long), env)
  f.advance(120_001)
  await f.authenticate(request(long), env)
  assert.equal(f.calls.length, 3)
  f.advance(6 * 60 * 60 * 1000)
  await f.authenticate(request(long), env)
  assert.equal(f.calls.length, 5)
})
test('Age reduces key cache lifetime and no-store never caches a provider response', async () => {
  const f = fixture(async (url) =>
    url === FIREBASE_APP_CHECK_JWKS_ENDPOINT
      ? json({ keys: [await jwk()] }, { 'Cache-Control': 'max-age=10', Age: '9' })
      : json({ 'key-0': await certificates[0] }, { 'Cache-Control': 'no-store' }),
  )
  const tokens = await credentials()
  await f.authenticate(request(tokens), env)
  await f.authenticate(request(tokens), env)
  assert.equal(f.calls.length, 3)
  f.advance(1001)
  await f.authenticate(request(tokens), env)
  assert.equal(f.calls.length, 5)
})
for (const [name, response] of Object.entries({
  upstream500: () => json({ private: 'detail' }, {}, 500),
  redirect: () =>
    new Response(null, { status: 302, headers: { Location: 'https://attacker.test' } }),
  wrongContentType: () => new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
  missingBody: () =>
    new Response(null, { status: 200, headers: { 'Content-Type': 'application/json' } }),
  malformed: () => new Response('{', { headers: { 'Content-Type': 'application/json' } }),
  hugeLength: () => json({}, { 'Content-Length': String(128 * 1024 + 1) }),
  hugeBody: () => json({ padding: 'x'.repeat(128 * 1024) }),
  invalidKeys: () => json({ keys: [] }),
  tooManyKeys: () => json({ keys: Array.from({ length: 21 }, () => ({})) }),
})) {
  test(`provider ${name} fails closed with sanitized 503`, async () => {
    const f = fixture(async () => response())
    await rejects(
      f.authenticate(request(await credentials()), env),
      503,
      'firebase_keys_unavailable',
    )
  })
}
for (const [name, override] of Object.entries({
  symmetric: { kty: 'oct', k: 'secret' },
  private: { d: 'private' },
  invalidModulus: { n: 'abc' },
  wrongAlg: { alg: 'HS256' },
  encryption: { use: 'enc' },
  badOps: { key_ops: ['sign'] },
  keyURL: { x5u: 'https://attacker.test' },
})) {
  test(`provider rejects ${name} key material`, async () => {
    const f = fixture(async () => json({ keys: [{ ...(await jwk()), ...override }] }))
    await rejects(
      f.authenticate(request(await credentials()), env),
      503,
      'firebase_keys_unavailable',
    )
  })
}
test('provider duplicate key IDs cannot produce an ambiguous verifier', async () => {
  const f = fixture(async () => json({ keys: [await jwk(), { ...(await jwk(1)), kid: 'key-0' }] }))
  await rejects(f.authenticate(request(await credentials()), env), 503, 'firebase_keys_unavailable')
})
test('ID endpoint requires the official certificate-map format, not arbitrary JWKS or invalid certificates', async () => {
  for (const body of [{ keys: [await jwk()] }, { 'key-0': 'bad certificate' }, {}]) {
    const f = fixture(async (url) =>
      url === FIREBASE_APP_CHECK_JWKS_ENDPOINT ? json({ keys: [await jwk()] }) : json(body),
    )
    await rejects(
      f.authenticate(request(await credentials()), env),
      503,
      'firebase_keys_unavailable',
    )
  }
})
test('unknown signed key returns invalid 401 after successful key fetch, not an upstream error', async () => {
  const f = fixture()
  await rejects(f.authenticate(request(await credentials({}, {}, { kid: 'missing-key' })), env))
  assert.equal(f.calls.length, 1)
})
test('provider network errors and stalled fetches are sanitized and bounded', async () => {
  const network = fixture(async () => {
    throw new Error('private upstream detail')
  })
  await rejects(
    network.authenticate(request(await credentials()), env),
    503,
    'firebase_keys_unavailable',
  )
  const stalled = fixture(async () => new Promise<Response>(() => {}), 10),
    tokens = await credentials(),
    start = performance.now()
  await rejects(stalled.authenticate(request(tokens), env), 503, 'firebase_keys_unavailable')
  assert.ok(performance.now() - start < 1000)
  assert.equal(stalled.calls[0].init?.signal?.aborted, true)
})
test('a stalled response body cannot keep authentication running past the provider timeout', async () => {
  let cancelled = false
  const f = fixture(
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise<void>(() => {})
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    10,
  )
  await rejects(f.authenticate(request(await credentials()), env), 503, 'firebase_keys_unavailable')
  assert.equal(cancelled, true)
  assert.equal(f.calls[0].init?.signal?.aborted, true)
})
test('token expiry is checked after key fetching, including App Check while ID keys are loading', async () => {
  for (const expired of ['app', 'id'] as const) {
    const f = fixture(async (url) => {
      if (url === FIREBASE_APP_CHECK_JWKS_ENDPOINT) return json({ keys: [await jwk()] })
      f.advance(2000)
      return json({ 'key-0': await certificates[0] })
    })
    const tokens =
      expired === 'app'
        ? await credentials({ exp: NOW / 1000 + 1 })
        : await credentials({}, { exp: NOW / 1000 + 1 })
    await rejects(f.authenticate(request(tokens), env))
  }
})
