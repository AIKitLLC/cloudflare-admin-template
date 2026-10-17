// @vitest-environment node
import { REST_POST } from '@payloadcms/next/routes'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ADMIN_SETUP_TOKEN_HEADER, ADMIN_SETUP_TOKEN_NAME } from '@/auth/first-admin'
import { LOGIN_THROTTLE_MAX_FAILURES } from '@/auth/login-throttle'
import config from '@/payload.config'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/rbac/guards/privilege-context'

const ORIGIN = 'http://localhost:3000'
const post = REST_POST(config)
const stamp = Date.now()
const setupToken = 'integration-only-setup-token-0123456789abcdef'
const password = 'integration-password-123'

let payload: Payload
let userId: number | string | undefined
let previousToken: string | undefined

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

function login(email: string, ip: string, pass = password) {
  return post(
    jsonRequest('/api/users/login', { email, password: pass }, { 'cf-connecting-ip': ip }),
    route(['users', 'login']),
  )
}

describe('admin hardening', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    previousToken = process.env[ADMIN_SETUP_TOKEN_NAME]
    process.env[ADMIN_SETUP_TOKEN_NAME] = setupToken
    const user = await payload.create({
      collection: 'users',
      data: { email: `hardening-${stamp}@example.com`, password, role: 'admin' },
      overrideAccess: true,
    })
    userId = user.id
  }, 120000)

  afterAll(async () => {
    if (previousToken === undefined) delete process.env[ADMIN_SETUP_TOKEN_NAME]
    else process.env[ADMIN_SETUP_TOKEN_NAME] = previousToken
    if (payload && userId !== undefined) {
      await payload.delete({
        collection: 'users',
        id: userId,
        overrideAccess: true,
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
    }
  }, 120000)

  it('does not create users over HTTP without a signed-in user, even with the setup token', async () => {
    for (const headers of [{}, { [ADMIN_SETUP_TOKEN_HEADER]: setupToken }]) {
      const created = await post(
        jsonRequest('/api/users', { email: `public-${stamp}@example.com`, password }, headers),
        route(['users']),
      )
      expect(created.status).toBe(403)
      const first = await post(
        jsonRequest(
          '/api/users/first-register',
          { email: `first-${stamp}@example.com`, password, 'confirm-password': password },
          headers,
        ),
        route(['users', 'first-register']),
      )
      expect(first.status).toBe(403)
    }
    const found = await payload.count({
      collection: 'users',
      where: { email: { like: `-${stamp}@example.com` } },
      overrideAccess: true,
    })
    expect(found.totalDocs).toBe(1)
  })

  it('uses non-Secure cookies outside production', () => {
    const users = payload.collections.users.config
    expect(users.auth.cookies.secure).toBe(false)
    expect(users.auth.cookies.sameSite).toBe('Lax')
  })

  it('answers 429 after repeated failed sign-ins from one IP and keeps other IPs working', async () => {
    const ip = `198.51.100.${stamp % 200}`
    for (let attempt = 0; attempt < LOGIN_THROTTLE_MAX_FAILURES; attempt += 1) {
      const failed = await login(`missing-${stamp}-${attempt}@example.com`, ip)
      expect(failed.status).toBe(401)
    }
    expect((await login(`hardening-${stamp}@example.com`, ip)).status).toBe(429)
    expect((await login(`hardening-${stamp}@example.com`, '2001:db8::77')).status).toBe(200)
  })

  it('does not count successful sign-ins against the IP', async () => {
    const ip = '192.0.2.44'
    for (let attempt = 0; attempt < LOGIN_THROTTLE_MAX_FAILURES + 2; attempt += 1) {
      expect((await login(`hardening-${stamp}@example.com`, ip)).status).toBe(200)
    }
  })
})
