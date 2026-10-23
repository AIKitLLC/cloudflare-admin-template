// @vitest-environment node
import { REST_POST } from '@payloadcms/next/routes'
import { getPayload, type Payload } from 'payload'
import { generatePayloadCookie } from 'payload/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  AUTH_THROTTLE_LIMITS,
  createLoginThrottle,
  LOGIN_THROTTLE_TABLE,
  type LoginThrottleDatabase,
} from '@/auth/login-throttle'
import { usersAuthOptions } from '@/auth/users-auth'
import config from '@/payload.config'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/access/privilege/privilege-context'

const ORIGIN = 'http://localhost:3000'
const post = REST_POST(config)
const stamp = Date.now()
const password = 'integration-password-123'
const email = `hardening-${stamp}@example.com`

let payload: Payload
let userId: number | string | undefined

function route(slug: string[]) {
  return { params: Promise.resolve({ slug }) }
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', origin: ORIGIN, ...headers }),
    body: JSON.stringify(body),
  })
}

function login(address: string, ip: string, pass = password) {
  return post(
    jsonRequest('/api/users/login', { email: address, password: pass }, { 'cf-connecting-ip': ip }),
    route(['users', 'login']),
  )
}

function binding(): LoginThrottleDatabase {
  return (payload.db as unknown as { binding: LoginThrottleDatabase }).binding
}

describe('admin hardening', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    const user = await payload.create({
      collection: 'users',
      data: { email, password, role: 'admin' },
      overrideAccess: true,
    })
    userId = user.id
  }, 120000)

  afterAll(async () => {
    if (payload && userId !== undefined) {
      await payload.delete({
        collection: 'users',
        id: userId,
        overrideAccess: true,
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
    }
  }, 120000)

  it('does not create users over HTTP without a signed-in user', async () => {
    const created = await post(
      jsonRequest('/api/users', { email: `public-${stamp}@example.com`, password }),
      route(['users']),
    )
    expect(created.status).toBe(403)
    const first = await post(
      jsonRequest('/api/users/first-register', {
        email: `first-${stamp}@example.com`,
        password,
        'confirm-password': password,
      }),
      route(['users', 'first-register']),
    )
    expect(first.status).toBe(403)
    const found = await payload.count({
      collection: 'users',
      where: { email: { like: `-${stamp}@example.com` } },
      overrideAccess: true,
    })
    expect(found.totalDocs).toBe(1)
  })

  it('sets SameSite=Lax without Secure outside production, and Secure in production', async () => {
    const response = await login(email, '2001:db8::10')
    expect(response.status).toBe(200)
    const cookie = (response.headers.getSetCookie?.() ?? []).find((value) =>
      value.startsWith('payload-token='),
    )
    expect(cookie).toBeTruthy()
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).not.toMatch(/;\s*Secure/i)
    // Payload's cookie writer with the sanitized users auth config and production options.
    const auth = payload.collections.users.config.auth
    const production = generatePayloadCookie({
      collectionAuthConfig: {
        ...auth,
        cookies: { ...auth.cookies, ...usersAuthOptions('production').cookies },
      },
      cookiePrefix: payload.config.cookiePrefix,
      token: 'synthetic',
    })
    expect(production).toMatch(/;\s*Secure/)
    expect(production).toContain('SameSite=Lax')
  })

  it('answers 429 after repeated failed sign-ins from one IP and keeps other IPs working', async () => {
    const ip = `198.51.100.${stamp % 200}`
    for (let attempt = 0; attempt < AUTH_THROTTLE_LIMITS.login; attempt += 1) {
      const failed = await login(`missing-${stamp}-${attempt}@example.com`, ip)
      expect(failed.status).toBe(401)
    }
    expect((await login(email, ip)).status).toBe(429)
    expect((await login(email, '2001:db8::77')).status).toBe(200)
  })

  it('does not count successful sign-ins against the IP', async () => {
    const ip = '192.0.2.44'
    for (let attempt = 0; attempt < AUTH_THROTTLE_LIMITS.login + 2; attempt += 1) {
      expect((await login(email, ip)).status).toBe(200)
    }
  })

  it('limits forgot-password, reset-password, and refresh per IP', async () => {
    const ip = '203.0.113.61'
    const cases = [
      {
        operation: 'forgotPassword' as const,
        path: ['users', 'forgot-password'],
        body: { email: `missing-${stamp}@example.com` },
      },
      {
        operation: 'resetPassword' as const,
        path: ['users', 'reset-password'],
        body: { token: 'not-a-reset-token', password },
      },
      { operation: 'refresh' as const, path: ['users', 'refresh-token'], body: {} },
    ]
    for (const { operation, path, body } of cases) {
      for (let attempt = 0; attempt < AUTH_THROTTLE_LIMITS[operation]; attempt += 1) {
        const response = await post(
          jsonRequest(`/api/${path.join('/')}`, body, { 'cf-connecting-ip': ip }),
          route(path),
        )
        expect(response.status, `${operation} attempt ${attempt}`).not.toBe(429)
      }
      const limited = await post(
        jsonRequest(`/api/${path.join('/')}`, body, { 'cf-connecting-ip': ip }),
        route(path),
      )
      expect(limited.status, operation).toBe(429)
    }
  }, 120000)

  it('limits the first-run setup endpoint per IP', async () => {
    const ip = '203.0.113.88'
    const attempt = () =>
      post(
        jsonRequest(
          '/api/users/first-register',
          { email: `setup-${stamp}@example.com`, password },
          { 'cf-connecting-ip': ip },
        ),
        route(['users', 'first-register']),
      )
    for (let count = 0; count < AUTH_THROTTLE_LIMITS.registerFirstUser; count += 1) {
      // Users exist, so setup is closed.
      expect((await attempt()).status).toBe(403)
    }
    expect((await attempt()).status).toBe(429)
  })

  it('does not count refreshes that carry a valid session', async () => {
    const ip = '203.0.113.90'
    const signedIn = await login(email, ip)
    expect(signedIn.status).toBe(200)
    const cookie = (signedIn.headers.getSetCookie?.() ?? [])
      .map((value) => value.split(';')[0])
      .join('; ')
    for (let attempt = 0; attempt < AUTH_THROTTLE_LIMITS.refresh + 5; attempt += 1) {
      const refreshed = await post(
        jsonRequest('/api/users/refresh-token', {}, { 'cf-connecting-ip': ip, cookie }),
        route(['users', 'refresh-token']),
      )
      expect(refreshed.status, `refresh ${attempt}`).toBe(200)
    }
  }, 120000)

  it('removes expired throttle rows while writing', async () => {
    const db = binding()
    const expiredKey = `expired-${stamp}`
    await db
      .prepare(
        `INSERT INTO ${LOGIN_THROTTLE_TABLE} (bucket_key, used, reset_at) VALUES (?1, 3, ?2)`,
      )
      .bind(expiredKey, Date.now() - 1000)
      .run()
    await createLoginThrottle(db).record(`fresh-${stamp}`)
    const remaining = await db
      .prepare(`SELECT count(*) AS n FROM ${LOGIN_THROTTLE_TABLE} WHERE bucket_key = ?1`)
      .bind(expiredKey)
      .first<{ n: number }>()
    expect(Number(remaining?.n)).toBe(0)
  })
})
