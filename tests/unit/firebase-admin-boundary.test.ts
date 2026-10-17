import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair, SignJWT } from 'jose'
import { JWTAuthentication, type Payload } from 'payload'

const secret = 'synthetic-payload-secret-for-auth-boundary-tests'

function fixture() {
  let lookups = 0
  const user = { id: 7, email: 'admin@fixture.invalid', sessions: [{ id: 'synthetic-session' }] }
  const payload = {
    secret,
    config: {
      admin: {},
      auth: { jwtOrder: ['Bearer', 'JWT', 'cookie'] },
      csrf: ['https://admin.example'],
      cookiePrefix: 'payload',
    },
    collections: { users: { config: { slug: 'users', auth: { depth: 0, useSessions: true } } } },
    findByID: async () => {
      lookups++
      return { ...user }
    },
  } as unknown as Payload
  return { payload, lookups: () => lookups }
}

test('Firebase RS256 bearer tokens cannot authenticate a Payload admin, even with forged admin claims', async () => {
  const f = fixture(),
    pair = await generateKeyPair('RS256')
  const now = Math.floor(Date.now() / 1000)
  const token = await new SignJWT({
    auth_time: now - 30,
    firebase: { sign_in_provider: 'anonymous' },
    collection: 'users',
    id: 7,
    sid: 'synthetic-session',
    role: 'admin',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-firebase-key', typ: 'JWT' })
    .setSubject('synthetic-uid')
    .setIssuer('https://securetoken.google.com/template-fixture')
    .setAudience('template-fixture')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(pair.privateKey)
  const result = await JWTAuthentication({
    payload: f.payload,
    headers: new Headers({ Authorization: `Bearer ${token}`, 'X-Firebase-AppCheck': token }),
  })
  assert.deepEqual(result, { user: null })
  assert.equal(f.lookups(), 0)
})

async function payloadToken() {
  return new SignJWT({ collection: 'users', id: 7, sid: 'synthetic-session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret))
}

test('existing Payload admin JWT authentication still accepts its own signed session token', async () => {
  const f = fixture()
  const result = await JWTAuthentication({
    payload: f.payload,
    headers: new Headers({ Authorization: `Bearer ${await payloadToken()}` }),
  })
  assert.equal(result.user?.id, 7)
  assert.equal(result.user?._strategy, 'local-jwt')
  assert.equal(f.lookups(), 1)
})

test('existing Payload cookie authentication keeps its Origin allowlist', async () => {
  const f = fixture(),
    token = await payloadToken()
  const untrusted = await JWTAuthentication({
    payload: f.payload,
    headers: new Headers({ Cookie: `payload-token=${token}`, Origin: 'https://spoofed.example' }),
  })
  assert.deepEqual(untrusted, { user: null })
  assert.equal(f.lookups(), 0)
  const trusted = await JWTAuthentication({
    payload: f.payload,
    headers: new Headers({ Cookie: `payload-token=${token}`, Origin: 'https://admin.example' }),
  })
  assert.equal(trusted.user?.id, 7)
  assert.equal(f.lookups(), 1)
})
