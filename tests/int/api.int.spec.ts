import { REST_DELETE, REST_GET, REST_PATCH, REST_POST } from '@payloadcms/next/routes'
import { getPayload, type Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { GET as nativeGet } from '@/app/api/client/v1/me/route'
import currentSchema from '@/migrations/20261017_133958_payload_3_91_security.json'
import { localIntegrationRuntime, registerIntegrationPayload } from './local-runtime'
import { initializeClientSecuritySchema } from '@/client-security/initialize'
import { createClientSecurityStore } from '@/client-security/store'

const get = REST_GET(config)
const post = REST_POST(config)
const patch = REST_PATCH(config)
const remove = REST_DELETE(config)
const params = (slug: string[]) => ({ params: Promise.resolve({ slug }) })
const runtime = localIntegrationRuntime()
let payload: Payload
let adminId: number | string
let adminToken: string
const email = 'local-admin@fixture.invalid'
const password = 'synthetic-integration-password'
const legacyMediaId = 17
const legacyFilename = 'existing-media.txt'
const legacyText = 'Existing local R2 media content'

async function uploadRequest(headers: Headers): Promise<Request> {
  const form = new FormData()
  form.set('_payload', JSON.stringify({ alt: 'Local R2 integration upload' }))
  form.set(
    'file',
    new Blob(['Synthetic R2 upload content'], { type: 'text/plain' }),
    'integration.txt',
  )
  const request = new Request('https://admin.fixture.invalid/api/media', {
    method: 'POST',
    headers,
    body: form,
  })
  const body = await request.arrayBuffer()
  request.headers.set('Content-Length', String(body.byteLength))
  return new Request(request.url, { method: 'POST', headers: request.headers, body })
}

describe('local Payload D1 and client authentication', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    registerIntegrationPayload(payload)
    await initializeClientSecuritySchema(runtime.platform.env.D1)
    const admin = await payload.create({
      collection: 'users',
      data: { email, password, role: 'admin' },
    })
    adminId = admin.id
    adminToken = (await payload.login({ collection: 'users', data: { email, password } })).token!
    await runtime.platform.env.D1.prepare(
      'INSERT INTO media (id, alt, filename, mime_type, filesize) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(
        legacyMediaId,
        'Existing media metadata',
        legacyFilename,
        'text/plain',
        legacyText.length,
      )
      .run()
    await runtime.platform.env.R2.put(legacyFilename, legacyText, {
      httpMetadata: { contentType: 'text/plain' },
    })
  })

  it('creates and reads the administrator from an isolated real local D1 database', async () => {
    const users = await payload.find({ collection: 'users', overrideAccess: true })
    expect(users.docs.map((user) => user.email)).toEqual([email])
    const tables = await runtime.platform.env.D1.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
    ).all()
    expect(tables.results).toEqual([{ name: 'users' }])
  })

  it('keeps unauthenticated Payload REST access restricted', async () => {
    const me = await get(
      new Request('https://admin.fixture.invalid/api/users/me'),
      params(['users', 'me']),
    )
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ user: null })
    const users = await get(
      new Request('https://admin.fixture.invalid/api/users'),
      params(['users']),
    )
    expect(users.status).toBe(403)
    const login = await post(
      new Request('https://admin.fixture.invalid/api/users/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'missing@fixture.invalid', password }),
      }),
      params(['users', 'login']),
    )
    expect(login.status).toBe(401)
  })

  it('preserves real Payload administrator login and bearer session authentication', async () => {
    const login = await post(
      new Request('https://admin.fixture.invalid/api/users/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }),
      params(['users', 'login']),
    )
    expect(login.status).toBe(200)
    const result = (await login.json()) as { user: { id: number | string }; token: string }
    expect(result.user.id).toBe(adminId)
    expect(login.headers.get('Set-Cookie')).toContain('payload-token=')
    adminToken = result.token
    const users = await get(
      new Request('https://admin.fixture.invalid/api/users', {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      params(['users']),
    )
    expect(users.status).toBe(200)
    expect(await users.json()).toMatchObject({ docs: [{ email }], totalDocs: 1 })
  })

  it('does not grant Payload administrator access to signed Firebase tokens with forged admin claims', async () => {
    const headers = await runtime.fixture.headers({
      collection: 'users',
      id: adminId,
      role: 'admin',
      sid: 'forged-session',
    })
    const me = await get(
      new Request('https://admin.fixture.invalid/api/users/me', { headers }),
      params(['users', 'me']),
    )
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ user: null })
    const users = await get(
      new Request('https://admin.fixture.invalid/api/users', { headers }),
      params(['users']),
    )
    expect(users.status).toBe(403)
    for (const [method, handler, slug, data] of [
      ['POST', post, ['users'], { email: 'forged-admin@fixture.invalid', password }],
      ['PATCH', patch, ['users', String(adminId)], { email: 'modified@fixture.invalid' }],
      ['DELETE', remove, ['users', String(adminId)], undefined],
    ] as const) {
      const requestHeaders = new Headers(headers)
      requestHeaders.set('Content-Type', 'application/json')
      const response = await handler(
        new Request(`https://admin.fixture.invalid/api/${slug.join('/')}`, {
          method,
          headers: requestHeaders,
          body: data ? JSON.stringify(data) : undefined,
        }),
        params([...slug]),
      )
      expect(response.status).toBe(403)
    }
    expect((await payload.find({ collection: 'users' })).docs.map((user) => user.email)).toEqual([
      email,
    ])
  })

  it('matches generated media columns to the existing migration snapshot and preserves seeded metadata', async () => {
    const columns = await runtime.platform.env.D1.prepare('PRAGMA table_info(media)').all<{
      name: string
    }>()
    expect(columns.results.map((column) => column.name).sort()).toEqual(
      Object.keys(currentSchema.tables.media.columns).sort(),
    )
    const response = await get(
      new Request(`https://admin.fixture.invalid/api/media/${legacyMediaId}`),
      params(['media', String(legacyMediaId)]),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: legacyMediaId,
      alt: 'Existing media metadata',
      filename: legacyFilename,
    })
  })

  it('keeps public media reads and denies anonymous or Firebase-only media writes', async () => {
    const read = await get(
      new Request(`https://admin.fixture.invalid/api/media/file/${legacyFilename}`),
      params(['media', 'file', legacyFilename]),
    )
    expect(read.status).toBe(200)
    expect(await read.text()).toBe(legacyText)
    for (const headers of [new Headers(), await runtime.fixture.headers()]) {
      const create = await post(await uploadRequest(headers), params(['media']))
      expect(create.status).toBe(403)
      const update = await patch(
        new Request(`https://admin.fixture.invalid/api/media/${legacyMediaId}`, {
          method: 'PATCH',
          headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' },
          body: JSON.stringify({ alt: 'Forbidden update' }),
        }),
        params(['media', String(legacyMediaId)]),
      )
      expect(update.status).toBe(403)
      const deleted = await remove(
        new Request(`https://admin.fixture.invalid/api/media/${legacyMediaId}`, {
          method: 'DELETE',
          headers,
        }),
        params(['media', String(legacyMediaId)]),
      )
      expect(deleted.status).toBe(403)
    }
  })

  it('stores authorized REST media uploads in real local R2 and preserves existing records through CRUD', async () => {
    const headers = new Headers({ Authorization: `Bearer ${adminToken}` })
    const response = await post(await uploadRequest(headers), params(['media']))
    expect(response.status).toBe(201)
    const { doc } = (await response.json()) as {
      doc: { id: number | string; filename: string; alt: string }
    }
    expect(doc.alt).toBe('Local R2 integration upload')
    const stored = await runtime.platform.env.R2.get(doc.filename)
    expect(await stored!.text()).toBe('Synthetic R2 upload content')
    const publicRead = await get(
      new Request(`https://admin.fixture.invalid/api/media/file/${doc.filename}`),
      params(['media', 'file', doc.filename]),
    )
    expect(publicRead.status).toBe(200)
    expect(await publicRead.text()).toBe('Synthetic R2 upload content')
    headers.set('Content-Type', 'application/json')
    const update = await patch(
      new Request(`https://admin.fixture.invalid/api/media/${doc.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ alt: 'Updated upload metadata' }),
      }),
      params(['media', String(doc.id)]),
    )
    expect(update.status).toBe(200)
    expect(await update.json()).toMatchObject({
      doc: { id: doc.id, alt: 'Updated upload metadata', filename: doc.filename },
    })
    const deleted = await remove(
      new Request(`https://admin.fixture.invalid/api/media/${doc.id}`, {
        method: 'DELETE',
        headers,
      }),
      params(['media', String(doc.id)]),
    )
    expect(deleted.status).toBe(200)
    expect(await runtime.platform.env.R2.get(doc.filename)).toBeNull()
    const legacy = await payload.findByID({ collection: 'media', id: legacyMediaId })
    expect(legacy).toMatchObject({
      alt: 'Existing media metadata',
      filename: legacyFilename,
      filesize: legacyText.length,
    })
    expect(await (await runtime.platform.env.R2.get(legacyFilename))!.text()).toBe(legacyText)
  })

  it('keeps the real native handler closed when disabled or missing either credential', async () => {
    runtime.env.FIREBASE_CLIENT_ENABLED = 'false'
    const disabled = await nativeGet(new Request('https://native.fixture.invalid/api/client/v1/me'))
    expect(disabled.status).toBe(503)
    expect(await disabled.json()).toEqual({ error: 'firebase_client_disabled' })
    runtime.env.FIREBASE_CLIENT_ENABLED = 'true'
    const store = createClientSecurityStore(runtime.platform.env.D1)
    const preview = await store.preview({
      schemaVersion: 1,
      firebase: {
        enabled: true,
        projectId: runtime.env.FIREBASE_PROJECT_ID,
        projectNumber: runtime.env.FIREBASE_PROJECT_NUMBER,
        appIds: [runtime.env.FIREBASE_APP_IDS],
      },
      limits: { windowSeconds: 60, uid: 100, ip: 100, global: 100 },
    })
    await store.save({
      expectedRevision: preview.currentRevision,
      configuration: preview.configuration,
      reviewedDigest: preview.digest,
      actor: 'test-operator',
      operation: 'save',
    })
    for (const missing of ['Authorization', 'X-Firebase-AppCheck']) {
      const headers = await runtime.fixture.headers()
      headers.delete(missing)
      const response = await nativeGet(
        new Request('https://native.fixture.invalid/api/client/v1/me', { headers }),
      )
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'firebase_credentials_missing' })
    }
  })

  it('verifies both signed credentials through the real native route and derives only the client principal', async () => {
    const headers = await runtime.fixture.headers({
      collection: 'users',
      id: adminId,
      role: 'admin',
    })
    headers.set('Origin', 'https://spoofed.fixture.invalid')
    headers.set('CF-Connecting-IP', '192.0.2.1')
    const response = await nativeGet(
      new Request('https://native.fixture.invalid/api/client/v1/me', { headers }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      principal: {
        uid: 'integration-anonymous-uid',
        appId: runtime.env.FIREBASE_APP_IDS,
        projectId: runtime.env.FIREBASE_PROJECT_ID,
      },
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.has('Set-Cookie')).toBe(false)
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false)
  })

  it('rejects either independently invalid signature through the real native route', async () => {
    for (const invalidSignature of ['app', 'id'] as const) {
      const headers = await runtime.fixture.headers({}, invalidSignature)
      const response = await nativeGet(
        new Request('https://native.fixture.invalid/api/client/v1/me', { headers }),
      )
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'firebase_credentials_invalid' })
    }
  })

  it('rejects existing Payload administrator credentials and a wrong Firebase project on the native route', async () => {
    const adminHeaders = await runtime.fixture.headers()
    adminHeaders.set('Authorization', `Bearer ${adminToken}`)
    const adminResponse = await nativeGet(
      new Request('https://native.fixture.invalid/api/client/v1/me', { headers: adminHeaders }),
    )
    expect(adminResponse.status).toBe(401)
    const wrongProject = await runtime.fixture.headers({ aud: 'another-project' })
    const response = await nativeGet(
      new Request('https://native.fixture.invalid/api/client/v1/me', { headers: wrongProject }),
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'firebase_credentials_invalid' })
  })
})
