import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { PayloadRequest } from 'payload'

import { allowsUserCreation, guardPublicUserCreation } from '../../src/auth/first-admin'
import {
  admitAuthAttempt,
  AUTH_THROTTLE_LIMITS,
  createLoginThrottle,
  isThrottledAuthOperation,
  loginThrottleClientIp,
  loginThrottleKey,
  resetAuthThrottleLogForTests,
  type LoginThrottleDatabase,
} from '../../src/auth/login-throttle'
import { usersAuthOptions } from '../../src/auth/users-auth'
import { testRuntimeStorageDir, testRuntimeWranglerConfig } from '../../src/config/test-runtime'
import { createFirstAdmin, parseFirstAdminArguments } from '../../scripts/create-first-admin.mjs'

test('users creation needs a signed-in user or the Local API', () => {
  assert.equal(allowsUserCreation({ payloadAPI: 'REST', user: null }), false)
  assert.equal(allowsUserCreation({ payloadAPI: 'GraphQL', user: null }), false)
  assert.equal(
    allowsUserCreation({ payloadAPI: 'REST', user: { id: 1 } as PayloadRequest['user'] }),
    true,
  )
  assert.equal(allowsUserCreation({ payloadAPI: 'local', user: null }), true)
})

test('the users create hook refuses requests without a user before any lookup', () => {
  const req = {
    payloadAPI: 'REST',
    user: null,
    t: ((key: string) => key) as PayloadRequest['t'],
    // No payload or database: the decision must not depend on how many users exist.
  } as unknown as PayloadRequest
  const hookArgs = { args: {}, operation: 'create', req } as unknown as Parameters<
    typeof guardPublicUserCreation
  >[0]
  assert.throws(
    () => guardPublicUserCreation(hookArgs),
    (error: { status?: number }) => error.status === 403,
  )
  const read = { ...hookArgs, operation: 'read' } as typeof hookArgs
  assert.deepEqual(guardPublicUserCreation(read), {})
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
              if (query.startsWith('DELETE')) {
                const [at, keep] = values as [number, string]
                for (const [key, row] of rows)
                  if (row.reset_at <= at && key !== keep) rows.delete(key)
                return {}
              }
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
  // The expired 'other' row is removed while 'k' is written.
  assert.equal((await throttle.record('k')).allowed, true)
  assert.equal(rows.has('other'), false)
})

test('auth operations each have a limit and their own counter', () => {
  for (const operation of ['login', 'forgotPassword', 'resetPassword', 'refresh']) {
    assert.equal(isThrottledAuthOperation(operation), true)
  }
  assert.equal(isThrottledAuthOperation('create'), false)
  assert.equal(AUTH_THROTTLE_LIMITS.login, 10)
  assert.notEqual(loginThrottleKey('192.0.2.1', 'login'), loginThrottleKey('192.0.2.1', 'refresh'))
})

function authRequest(headers: Headers, binding?: LoginThrottleDatabase): PayloadRequest {
  return {
    payloadAPI: 'REST',
    headers,
    payload: { db: binding ? { binding } : {} },
  } as unknown as PayloadRequest
}

test('production refuses auth requests when the throttle database is unavailable', async () => {
  resetAuthThrottleLogForTests()
  const errors: unknown[] = []
  const original = console.error
  console.error = (...args: unknown[]) => errors.push(args)
  try {
    const req = authRequest(new Headers({ 'cf-connecting-ip': '192.0.2.1' }))
    await assert.rejects(
      admitAuthAttempt(req, 'login', 'production'),
      (error: { status?: number }) => error.status === 503,
    )
    assert.equal(errors.length, 1)
    // Outside production the throttle is skipped without a database.
    await admitAuthAttempt(req, 'login', 'development')
  } finally {
    console.error = original
  }
})

test('production refuses auth requests without CF-Connecting-IP', async () => {
  const db: LoginThrottleDatabase = {
    prepare: () => ({
      bind: () => ({
        first: async <T>() => ({ used: 1, reset_at: Date.now() + 1000 }) as T,
        run: async () => ({}),
      }),
    }),
  }
  await assert.rejects(
    admitAuthAttempt(authRequest(new Headers(), db), 'login', 'production'),
    (error: { status?: number }) => error.status === 400,
  )
  await admitAuthAttempt(authRequest(new Headers(), db), 'login', 'test')
  await admitAuthAttempt(
    authRequest(new Headers({ 'cf-connecting-ip': '192.0.2.9' }), db),
    'login',
    'production',
  )
})

test('homepage has no editor file links', () => {
  const page = readFileSync(new URL('../../src/app/(frontend)/page.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(page, /vscode:\/\//)
})
