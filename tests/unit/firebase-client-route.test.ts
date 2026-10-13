import assert from 'node:assert/strict'
import test from 'node:test'

import { FirebaseAuthError, type FirebaseClientIdentity } from '../../src/auth/firebase-client'
import {
  createFirebaseClientRoute,
  firebaseClientOwnsRecord,
  firebaseClientQuotaKey,
} from '../../src/auth/firebase-client-route'

const principal: FirebaseClientIdentity = Object.freeze({
  uid: 'verified-anonymous-account',
  appId: '1:123456789:android:fixture',
  projectId: 'template-fixture',
})

test('the handler receives only the verified principal after authentication, regardless of body or Origin', async () => {
  const events: string[] = []
  const env = { FIREBASE_CLIENT_ENABLED: 'true' }
  const route = createFirebaseClientRoute(
    async (request, identity) => {
      events.push('handler')
      assert.equal(identity, principal)
      assert.deepEqual(await request.json(), { uid: 'forged-owner', role: 'admin' })
      return Response.json({ principal: identity }, { headers: { Vary: 'Accept' } })
    },
    {
      getEnv: () => {
        events.push('env')
        return env
      },
      authenticate: async (_request, bindings) => {
        events.push('authenticate')
        assert.equal(bindings, env)
        return principal
      },
    },
  )
  for (const origin of [undefined, 'https://spoofed.example']) {
    events.length = 0
    const response = await route(
      new Request('https://template.example/api/client/v1/me', {
        method: 'POST',
        headers: origin ? { Origin: origin } : {},
        body: JSON.stringify({ uid: 'forged-owner', role: 'admin' }),
      }),
    )
    assert.deepEqual(events, ['env', 'authenticate', 'handler'])
    assert.deepEqual(await response.json(), { principal })
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    assert.equal(response.headers.get('Vary'), 'Accept, Authorization, X-Firebase-AppCheck')
    assert.equal(response.headers.has('Access-Control-Allow-Origin'), false)
    assert.equal(response.headers.has('Set-Cookie'), false)
    assert.equal('role' in principal, false)
    assert.equal('email' in principal, false)
  }
})

for (const [status, reason] of [
  [401, 'firebase_credentials_missing'],
  [401, 'firebase_credentials_invalid'],
  [503, 'firebase_keys_unavailable'],
  [503, 'firebase_client_disabled'],
  [503, 'firebase_client_misconfigured'],
] as const) {
  test(`${reason} never invokes application work and returns a private ${status}`, async () => {
    let called = false
    const route = createFirebaseClientRoute(
      () => {
        called = true
        return Response.json({ ok: true })
      },
      {
        getEnv: () => ({}),
        authenticate: async () => {
          throw new FirebaseAuthError(status, reason)
        },
      },
    )
    const response = await route(new Request('https://template.example/api/client/v1/me'))
    assert.equal(called, false)
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { error: reason })
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    assert.equal(response.headers.get('WWW-Authenticate'), status === 401 ? 'Bearer' : null)
    assert.equal(response.headers.has('Set-Cookie'), false)
  })
}

for (const source of ['env', 'authenticate'] as const) {
  test(`unexpected ${source} failures are closed without exposing error details`, async () => {
    let called = false
    const route = createFirebaseClientRoute(
      () => {
        called = true
        return Response.json({ ok: true })
      },
      {
        getEnv: () => {
          if (source === 'env') throw new Error('raw-token-canary')
          return {}
        },
        authenticate: async () => {
          throw new Error('raw-token-canary')
        },
      },
    )
    const response = await route(new Request('https://template.example/'))
    assert.equal(called, false)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'firebase_auth_unavailable' })
  })
}

test('application exceptions stay outside the auth error boundary', async () => {
  const route = createFirebaseClientRoute(
    () => {
      throw new Error('application-failure')
    },
    { getEnv: () => ({}), authenticate: async () => principal },
  )
  await assert.rejects(route(new Request('https://template.example/')), /application-failure/)
})

test('ownership and quota keys use the verified project and UID', () => {
  assert.equal(
    firebaseClientOwnsRecord(principal, {
      firebaseProjectId: principal.projectId,
      firebaseUid: principal.uid,
    }),
    true,
  )
  assert.equal(
    firebaseClientOwnsRecord(principal, {
      firebaseProjectId: principal.projectId,
      firebaseUid: 'someone-else',
    }),
    false,
  )
  assert.equal(
    firebaseClientOwnsRecord(principal, {
      firebaseProjectId: 'another-project',
      firebaseUid: principal.uid,
    }),
    false,
  )
  assert.deepEqual(JSON.parse(firebaseClientQuotaKey(principal)), [
    principal.projectId,
    principal.uid,
  ])
  assert.equal(
    firebaseClientQuotaKey(principal),
    firebaseClientQuotaKey({ ...principal, appId: 'another-allowed-app' }),
  )
  assert.notEqual(
    firebaseClientQuotaKey(principal),
    firebaseClientQuotaKey({ ...principal, uid: 'someone-else' }),
  )
  assert.notEqual(
    firebaseClientQuotaKey(principal),
    firebaseClientQuotaKey({ ...principal, projectId: 'another-project' }),
  )
  assert.notEqual(
    firebaseClientQuotaKey({ ...principal, projectId: 'a:b', uid: 'c' }),
    firebaseClientQuotaKey({ ...principal, projectId: 'a', uid: 'b:c' }),
  )
})
