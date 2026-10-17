import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ADMIN_SETUP_TOKEN_MIN_LENGTH,
  decidePublicUserCreation,
  setupTokenMatches,
} from '../../src/auth/first-admin'
import {
  createLoginThrottle,
  loginThrottleClientIp,
  loginThrottleKey,
  type LoginThrottleDatabase,
} from '../../src/auth/login-throttle'
import { usersAuthOptions } from '../../src/auth/users-auth'
import { testRuntimeStorageDir, testRuntimeWranglerConfig } from '../../src/config/test-runtime'
import { createFirstAdmin, parseFirstAdminArguments } from '../../scripts/create-first-admin.mjs'

const token = 'a'.repeat(ADMIN_SETUP_TOKEN_MIN_LENGTH)

test('setup token must be configured, long enough, and equal', () => {
  assert.equal(setupTokenMatches(token, token), true)
  assert.equal(setupTokenMatches(`${token}b`, token), false)
  assert.equal(setupTokenMatches('', token), false)
  assert.equal(setupTokenMatches(null, token), false)
  assert.equal(setupTokenMatches(token, undefined), false)
  assert.equal(setupTokenMatches('short', 'short'), false)
})

test('first-admin bootstrap: a request without a user needs the token and an empty users table', () => {
  const base = { hasUser: false, existingUsers: 0, providedToken: token, expectedToken: token }
  assert.equal(decidePublicUserCreation({ ...base, payloadAPI: 'REST' }), 'allow')
  assert.equal(decidePublicUserCreation({ ...base, payloadAPI: 'GraphQL' }), 'allow')
  assert.equal(
    decidePublicUserCreation({ ...base, payloadAPI: 'REST', providedToken: undefined }),
    'deny',
  )
  assert.equal(
    decidePublicUserCreation({ ...base, payloadAPI: 'REST', expectedToken: undefined }),
    'deny',
  )
  assert.equal(decidePublicUserCreation({ ...base, payloadAPI: 'REST', existingUsers: 1 }), 'deny')
  // Signed-in and Local API calls stay with the normal access rules.
  assert.equal(
    decidePublicUserCreation({ ...base, payloadAPI: 'REST', hasUser: true, existingUsers: 3 }),
    'allow',
  )
  assert.equal(
    decidePublicUserCreation({ ...base, payloadAPI: 'local', providedToken: undefined }),
    'allow',
  )
})

test('admin:create arguments and password source', () => {
  const env = { FIRST_ADMIN_PASSWORD: 'correct-horse-battery' } as unknown as NodeJS.ProcessEnv
  assert.deepEqual(parseFirstAdminArguments(['--', '--email', 'a@example.com', '--confirm'], env), {
    email: 'a@example.com',
    password: env.FIRST_ADMIN_PASSWORD,
  })
  assert.throws(() => parseFirstAdminArguments(['--email', 'a@example.com'], env))
  assert.throws(() => parseFirstAdminArguments(['--email', 'nope', '--confirm'], env))
  assert.throws(() =>
    parseFirstAdminArguments(['--email', 'a@example.com', '--confirm'], {
      FIRST_ADMIN_PASSWORD: 'short',
    } as unknown as NodeJS.ProcessEnv),
  )
})

test('admin:create creates only the first user', async () => {
  const created: unknown[] = []
  const fake = (totalDocs: number) => ({
    count: async () => ({ totalDocs }),
    create: async (args: { data: unknown }) => {
      created.push(args.data)
      return { id: 1 }
    },
  })
  assert.deepEqual(await createFirstAdmin(fake(0), { email: 'a@example.com', password: 'x' }), {
    id: 1,
  })
  assert.equal(created.length, 1)
  await assert.rejects(
    createFirstAdmin(fake(1), { email: 'b@example.com', password: 'x' }),
    (error: { status?: number }) => error.status === 409,
  )
  assert.equal(created.length, 1)
})

test('users auth cookies are Secure in production', () => {
  const production = usersAuthOptions('production')
  assert.equal(typeof production, 'object')
  assert.equal(production.cookies?.secure, true)
  assert.equal(production.cookies?.sameSite, 'Lax')
  assert.equal(usersAuthOptions('development').cookies?.secure, false)
  assert.equal(usersAuthOptions('test').cookies?.secure, false)
  assert.equal(production.maxLoginAttempts, 5)
})

test('production ignores the integration-test runtime variables', () => {
  assert.equal(
    testRuntimeWranglerConfig({ nodeEnv: 'production', wranglerConfig: '/tmp/wrangler.json' }),
    undefined,
  )
  assert.equal(
    testRuntimeStorageDir({ nodeEnv: 'production', storageDir: '/tmp/state' }),
    undefined,
  )
  assert.equal(
    testRuntimeWranglerConfig({ nodeEnv: 'development', wranglerConfig: '/tmp/wrangler.json' }),
    '/tmp/wrangler.json',
  )
  assert.equal(testRuntimeStorageDir({ nodeEnv: 'test', storageDir: '/tmp/state' }), '/tmp/state')
  assert.equal(testRuntimeWranglerConfig({ nodeEnv: 'test', wranglerConfig: '' }), undefined)
})

test('login throttle key uses the Cloudflare client IP header', () => {
  assert.equal(
    loginThrottleClientIp(new Headers({ 'cf-connecting-ip': '203.0.113.7' })),
    '203.0.113.7',
  )
  assert.equal(
    loginThrottleClientIp(new Headers({ 'cf-connecting-ip': '2001:DB8::1' })),
    '2001:db8::1',
  )
  assert.equal(loginThrottleClientIp(new Headers({ 'cf-connecting-ip': 'not an ip' })), 'unknown')
  assert.equal(loginThrottleClientIp(new Headers()), 'unknown')
  assert.match(loginThrottleKey('203.0.113.7'), /^[0-9a-f]{64}$/)
  assert.notEqual(loginThrottleKey('203.0.113.7'), loginThrottleKey('203.0.113.8'))
})

test('login throttle counts attempts per key and gives back successful ones', async () => {
  // In-memory stand-in for the D1 statements, keyed like the table.
  const rows = new Map<string, { used: number; reset_at: number }>()
  let now = 1_000
  const db: LoginThrottleDatabase = {
    prepare(query) {
      return {
        bind(...values) {
          return {
            async first<T>() {
              const [key, resetAt, at] = values as [string, number, number]
              const row = rows.get(key)
              const next =
                !row || row.reset_at <= at
                  ? { used: 1, reset_at: resetAt }
                  : { used: row.used + 1, reset_at: row.reset_at }
              rows.set(key, next)
              return next as T
            },
            async run() {
              assert.match(query, /^UPDATE/)
              const [key, at] = values as [string, number]
              const row = rows.get(key)
              if (row && row.reset_at > at) row.used = Math.max(row.used - 1, 0)
              return {}
            },
          }
        },
      }
    },
  }
  const throttle = createLoginThrottle(db, { maxFailures: 3, windowMs: 100, nowMs: () => now })
  assert.equal((await throttle.record('k')).allowed, true)
  await throttle.release('k')
  for (let index = 0; index < 3; index += 1)
    assert.equal((await throttle.record('k')).allowed, true)
  assert.equal((await throttle.record('k')).allowed, false)
  assert.equal((await throttle.record('other')).allowed, true)
  now += 100
  assert.equal((await throttle.record('k')).allowed, true)
})

test('homepage has no editor file links', () => {
  const page = readFileSync(new URL('../../src/app/(frontend)/page.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(page, /vscode:\/\//)
})
