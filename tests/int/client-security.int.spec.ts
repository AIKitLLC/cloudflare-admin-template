import { getPayload, type Payload } from 'payload'
import { REST_DELETE, REST_GET, REST_PATCH, REST_POST } from '@payloadcms/next/routes'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { GET as adminGet, POST as adminPost } from '@/app/api/admin/client-security/route'
import type { FirebaseClientIdentity } from '@/auth/firebase-client'
import { initializeClientSecuritySchema } from '@/client-security/initialize'
import {
  clientSecurityBucketKeys,
  createClientSecurityRateLimiter,
} from '@/client-security/rate-limits'
import {
  DEFAULT_CLIENT_SECURITY_CONFIGURATION,
  type ClientSecurityConfiguration,
} from '@/client-security/schema'
import { createClientSecurityStore, type ClientSecuritySnapshot } from '@/client-security/store'
import config from '@/payload.config'
import { up as migrateClientSecurity } from '@/migrations/20261013_120000'

import { bootstrapClientSecurityOwner } from '../../scripts/bootstrap-client-security-owner.mjs'

import { firebaseFixtureEnv } from './firebase-fixture'
import { localIntegrationRuntime, registerIntegrationPayload } from './local-runtime'

const runtime = localIntegrationRuntime()
const db = runtime.platform.env.D1
const initialTime = 1_800_000_000_000
let time = initialTime
let payload: Payload
let ownerId: number | string
let ownerToken: string
let secondaryId: number | string
let adminToken: string
let editorToken: string
const password = 'synthetic-integration-password'
const adminUrl = 'https://admin.fixture.invalid/api/admin/client-security'
const get = REST_GET(config)
const post = REST_POST(config)
const patch = REST_PATCH(config)
const remove = REST_DELETE(config)
const params = (slug: string[]) => ({ params: Promise.resolve({ slug }) })
const store = createClientSecurityStore(db, { nowMs: () => time })
const limiter = createClientSecurityRateLimiter(db, { nowMs: () => time })

function configuration(
  limits: Partial<ClientSecurityConfiguration['limits']> = {},
  firebase: Partial<ClientSecurityConfiguration['firebase']> = {},
): ClientSecurityConfiguration {
  return {
    schemaVersion: 1,
    firebase: {
      enabled: true,
      projectId: firebaseFixtureEnv.FIREBASE_PROJECT_ID,
      projectNumber: firebaseFixtureEnv.FIREBASE_PROJECT_NUMBER,
      appIds: [firebaseFixtureEnv.FIREBASE_APP_IDS],
      ...firebase,
    },
    limits: { windowSeconds: 60, uid: 100, ip: 100, global: 100, ...limits },
  }
}

function principal(
  uid = 'local-anonymous-uid',
  projectId = firebaseFixtureEnv.FIREBASE_PROJECT_ID,
): FirebaseClientIdentity {
  return { uid, projectId, appId: firebaseFixtureEnv.FIREBASE_APP_IDS }
}

async function save(configuration: ClientSecurityConfiguration): Promise<ClientSecuritySnapshot> {
  const current = await store.read()
  const preview = await store.preview(configuration)
  return store.save({
    expectedRevision: current.revision,
    configuration,
    reviewedDigest: preview.digest,
    actor: 'payload-user:1',
    operation: 'save',
  })
}

async function counters() {
  const result = await db
    .prepare('SELECT bucket_key, used, reset_at FROM client_security_counters ORDER BY bucket_key')
    .all<{ bucket_key: string; used: number; reset_at: number }>()
  expect(result.success).toBe(true)
  return result.results
}

async function countRows(table: 'client_security_versions' | 'client_security_audit') {
  return (await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>())!
    .count
}

function adminRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(adminUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      Origin: new URL(adminUrl).origin,
      'Content-Type': 'application/json',
      'X-Client-Security-Action': 'manage',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe('client security with isolated real D1 transactions', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    registerIntegrationPayload(payload)
    await initializeClientSecuritySchema(db)
    const admin = await payload.create({
      collection: 'users',
      data: { email: 'security-admin@fixture.invalid', password, role: 'admin' },
    })
    const editor = await payload.create({
      collection: 'users',
      data: { email: 'security-editor@fixture.invalid', password, role: 'admin' },
    })
    await db.prepare("UPDATE users SET role = 'editor' WHERE id = ?").bind(editor.id).run()
    adminToken = (
      await payload.login({ collection: 'users', data: { email: admin.email, password } })
    ).token!
    editorToken = (
      await payload.login({ collection: 'users', data: { email: editor.email, password } })
    ).token!
  })

  beforeEach(async () => {
    time = initialTime
    await db.batch([
      db.prepare('DELETE FROM client_security_audit'),
      db.prepare('DELETE FROM client_security_counters'),
      db.prepare('DELETE FROM client_security_state'),
      db.prepare('DELETE FROM client_security_versions'),
    ])
    await initializeClientSecuritySchema(db)
  })

  it('allows exactly one operator bootstrap winner under simultaneous initial owner claims', async () => {
    const candidates = await Promise.all(
      [1, 2].map((index) =>
        payload.create({
          collection: 'users',
          data: { email: `bootstrap-candidate-${index}@fixture.invalid`, password, role: 'admin' },
        }),
      ),
    )
    const results = await Promise.allSettled(
      candidates.map((user) => bootstrapClientSecurityOwner(payload, Number(user.id))),
    )
    const winners = results.filter((result) => result.status === 'fulfilled')
    expect(winners).toHaveLength(1)
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 409 })
    const winner = winners[0]
    if (winner.status !== 'fulfilled') throw new Error('Expected a single initial owner')
    ownerId = winner.value.id
    secondaryId = candidates.find((candidate) => candidate.id !== ownerId)!.id
    ownerToken = (
      await payload.login({ collection: 'users', data: { email: winner.value.email, password } })
    ).token!
    expect(
      await payload.count({
        collection: 'users',
        overrideAccess: true,
        where: { role: { equals: 'owner' } },
      }),
    ).toMatchObject({ totalDocs: 1 })
  })

  it('starts disabled with zero quotas and never creates a runnable fallback on reads', async () => {
    const snapshot = await store.read()
    expect(snapshot).toMatchObject({
      revision: 0,
      configuration: DEFAULT_CLIENT_SECURITY_CONFIGURATION,
    })
    await expect(
      limiter.admit({ snapshot, principal: principal(), ip: '203.0.113.7' }),
    ).rejects.toMatchObject({ status: 503 })
    expect(await counters()).toEqual([])
    await db.prepare('DELETE FROM client_security_state WHERE id = 1').run()
    await expect(store.read()).rejects.toMatchObject({
      status: 503,
      reason: 'client_security_unavailable',
    })
    expect(await db.prepare('SELECT * FROM client_security_state').all()).toMatchObject({
      results: [],
    })
  })

  it('repeated initialization preserves configured revisions, existing counters, and users', async () => {
    const user = await payload.create({
      collection: 'users',
      data: {
        email: 'migration-preservation@fixture.invalid',
        password: 'synthetic-integration-password',
        role: 'admin',
      },
    })
    const snapshot = await save(configuration())
    await limiter.admit({ snapshot, principal: principal(), ip: '203.0.113.7' })
    const before = await counters()
    const history = await store.history()
    await initializeClientSecuritySchema(db)
    await initializeClientSecuritySchema(db)
    expect(await store.read()).toEqual(snapshot)
    expect(await counters()).toEqual(before)
    expect(await store.history()).toEqual(history)
    expect(await payload.findByID({ collection: 'users', id: user.id })).toMatchObject({
      id: user.id,
      email: user.email,
      role: 'admin',
    })
  })

  it('runs the actual Payload Drizzle migration twice without changing configured state, counters, users, or media', async () => {
    const snapshot = await save(configuration())
    await limiter.admit({ snapshot, principal: principal(), ip: '203.0.113.7' })
    await db
      .prepare('INSERT INTO media (id, alt, filename, mime_type, filesize) VALUES (?, ?, ?, ?, ?)')
      .bind(501, 'Migration preservation fixture', 'migration-preservation.txt', 'text/plain', 17)
      .run()
    const before = {
      counters: await counters(),
      users: (await db.prepare('SELECT id, email, role FROM users ORDER BY id').all()).results,
      media: (
        await db
          .prepare('SELECT id, alt, filename, mime_type, filesize FROM media ORDER BY id')
          .all()
      ).results,
      history: await store.history(),
    }
    // The actual migration only consumes Drizzle; this is its real Payload-owned D1 adapter.
    const args = { db: payload.db.drizzle } as Parameters<typeof migrateClientSecurity>[0]
    await migrateClientSecurity(args)
    await migrateClientSecurity(args)
    expect(await store.read()).toEqual(snapshot)
    expect(await counters()).toEqual(before.counters)
    expect(
      (await db.prepare('SELECT id, email, role FROM users ORDER BY id').all()).results,
    ).toEqual(before.users)
    expect(
      (
        await db
          .prepare('SELECT id, alt, filename, mime_type, filesize FROM media ORDER BY id')
          .all()
      ).results,
    ).toEqual(before.media)
    expect(await store.history()).toEqual(before.history)
  })

  it('commits exactly one concurrent CAS winner with one matching version and audit record', async () => {
    const choices = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const next = configuration({ uid: index + 5 })
        const preview = await store.preview(next)
        return { next, digest: preview.digest }
      }),
    )
    const results = await Promise.allSettled(
      choices.map(({ next, digest }, index) =>
        store.save({
          expectedRevision: 0,
          configuration: next,
          reviewedDigest: digest,
          actor: `payload-user:${index + 1}`,
          operation: 'save',
        }),
      ),
    )
    const winners = results.filter((result) => result.status === 'fulfilled')
    const losers = results.filter((result) => result.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(7)
    for (const loser of losers)
      if (loser.status === 'rejected')
        expect(loser.reason).toMatchObject({
          status: 409,
          reason: 'client_security_revision_conflict',
        })
    const winner = winners[0]
    if (winner.status !== 'fulfilled') throw new Error('Expected one committed configuration')
    expect(await store.read()).toEqual(winner.value)
    expect(await countRows('client_security_versions')).toBe(2)
    expect(await countRows('client_security_audit')).toBe(2)
    const audit = await db
      .prepare(
        'SELECT revision, previous_revision, actor, operation FROM client_security_audit WHERE revision = 1',
      )
      .first()
    const version = await store.readVersion(1)
    expect(audit).toEqual({
      revision: 1,
      previous_revision: 0,
      actor: version.actor,
      operation: 'save',
    })
  })

  it('rolls back the entire CAS transaction when audit insertion fails', async () => {
    const current = await store.read()
    const next = configuration()
    const preview = await store.preview(next)
    await db
      .prepare(
        "CREATE TRIGGER client_security_fixture_audit_failure BEFORE INSERT ON client_security_audit WHEN NEW.operation = 'save' BEGIN SELECT RAISE(ABORT, 'fixture_audit_failure'); END",
      )
      .run()
    try {
      await expect(
        store.save({
          expectedRevision: 0,
          configuration: next,
          reviewedDigest: preview.digest,
          actor: 'payload-user:1',
          operation: 'save',
        }),
      ).rejects.toMatchObject({ status: 503 })
      expect(await store.read()).toEqual(current)
      expect(await countRows('client_security_versions')).toBe(1)
      expect(await countRows('client_security_audit')).toBe(1)
    } finally {
      await db.prepare('DROP TRIGGER client_security_fixture_audit_failure').run()
    }
  })

  it('requires the reviewed digest and rejects stale saves without changing history', async () => {
    const next = configuration()
    const preview = await store.preview(next)
    await expect(
      store.save({
        expectedRevision: 0,
        configuration: next,
        reviewedDigest: '0'.repeat(64),
        actor: 'payload-user:1',
        operation: 'save',
      }),
    ).rejects.toMatchObject({ status: 400, reason: 'client_security_review_required' })
    await save(next)
    await expect(
      store.save({
        expectedRevision: 0,
        configuration: next,
        reviewedDigest: preview.digest,
        actor: 'payload-user:1',
        operation: 'save',
      }),
    ).rejects.toMatchObject({ status: 409 })
    expect(await countRows('client_security_versions')).toBe(2)
    expect(await countRows('client_security_audit')).toBe(2)
  })

  it.each([
    ['UID', { uid: 3 }, 3, false, false],
    ['IP', { ip: 2 }, 2, true, false],
    ['global', { global: 4 }, 4, true, true],
    ['all dimensions at one', { uid: 1, ip: 1, global: 1 }, 1, false, false],
  ] as const)(
    'atomically enforces %s quotas under parallel real D1 admissions',
    async (_, limits, allowed, uniqueUid, uniqueIp) => {
      const snapshot = await save(configuration(limits))
      const identities = Array.from({ length: 20 }, (_, index) =>
        principal(uniqueUid ? `parallel-user-${index}` : 'parallel-user'),
      )
      const ips = identities.map((_, index) =>
        uniqueIp ? `203.0.113.${index + 1}` : '203.0.113.7',
      )
      const results = await Promise.allSettled(
        identities.map((identity, index) =>
          limiter.admit({ snapshot, principal: identity, ip: ips[index] }),
        ),
      )
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(allowed)
      for (const result of results)
        if (result.status === 'rejected')
          expect(result.reason).toMatchObject({
            status: 429,
            reason: 'client_security_rate_limited',
            retryAfter: 60,
          })
      const rows = await counters()
      const globalKey = (await clientSecurityBucketKeys(identities[0], ips[0])).global
      expect(rows.find((row) => row.bucket_key === globalKey)!.used).toBe(allowed)
      const uidKeys = new Set(
        await Promise.all(
          identities.map(
            async (identity, index) => (await clientSecurityBucketKeys(identity, ips[index])).uid,
          ),
        ),
      )
      const ipKeys = new Set(
        await Promise.all(
          identities.map(
            async (identity, index) => (await clientSecurityBucketKeys(identity, ips[index])).ip,
          ),
        ),
      )
      expect(
        rows.filter((row) => uidKeys.has(row.bucket_key)).reduce((sum, row) => sum + row.used, 0),
      ).toBe(allowed)
      expect(
        rows.filter((row) => ipKeys.has(row.bucket_key)).reduce((sum, row) => sum + row.used, 0),
      ).toBe(allowed)
      expect(rows.every((row) => row.reset_at === initialTime / 1000 + 60)).toBe(true)
    },
  )

  it('does not partially charge the UID or global scope when the IP scope denies admission', async () => {
    const snapshot = await save(configuration({ uid: 1, ip: 1, global: 2 }))
    const a = principal('user-a'),
      b = principal('user-b')
    await limiter.admit({ snapshot, principal: a, ip: '203.0.113.7' })
    await expect(
      limiter.admit({ snapshot, principal: b, ip: '203.0.113.7' }),
    ).rejects.toMatchObject({ status: 429 })
    const bKeys = await clientSecurityBucketKeys(b, '203.0.113.7')
    const deniedRows = await counters()
    expect(deniedRows.find((row) => row.bucket_key === bKeys.uid)).toBeUndefined()
    expect(deniedRows).toHaveLength(3)
    expect(deniedRows.find((row) => row.bucket_key === bKeys.global)!.used).toBe(1)
    const accepted = await limiter.admit({ snapshot, principal: b, ip: '203.0.113.8' })
    expect(accepted.remaining).toEqual({ uid: 0, ip: 0, global: 0 })
  })

  it('applies a quota decrease immediately without resetting counters or existing window deadlines', async () => {
    const original = await save(configuration({ uid: 3, ip: 5, global: 10 }))
    const admission = { principal: principal(), ip: '203.0.113.7' }
    await limiter.admit({ snapshot: original, ...admission })
    await limiter.admit({ snapshot: original, ...admission })
    const before = await counters()
    time += 10_000
    const decreased = await save(configuration({ uid: 1, ip: 1, global: 1, windowSeconds: 120 }))
    await expect(limiter.admit({ snapshot: decreased, ...admission })).rejects.toMatchObject({
      status: 429,
      retryAfter: 50,
    })
    expect(await counters()).toEqual(before)
    time = initialTime + 60_000
    const accepted = await limiter.admit({ snapshot: decreased, ...admission })
    expect(accepted.remaining).toEqual({ uid: 0, ip: 0, global: 0 })
    expect(Object.values(accepted.resetAt)).toEqual([
      initialTime / 1000 + 180,
      initialTime / 1000 + 180,
      initialTime / 1000 + 180,
    ])
    expect((await counters()).every((row) => row.used === 1)).toBe(true)
  })

  it('rejects a stale configuration snapshot without adding or consuming buckets', async () => {
    const stale = await save(configuration())
    await save(configuration({ uid: 2 }))
    await expect(
      limiter.admit({ snapshot: stale, principal: principal(), ip: '203.0.113.7' }),
    ).rejects.toMatchObject({ status: 503 })
    expect(await counters()).toEqual([])
  })

  it('preserves IP and global consumption across a Firebase project change', async () => {
    const original = await save(configuration({ global: 1 }))
    await limiter.admit({ snapshot: original, principal: principal(), ip: '203.0.113.7' })
    const next = await save(
      configuration({ global: 1 }, { projectId: 'another-integration-project' }),
    )
    await expect(
      limiter.admit({
        snapshot: next,
        principal: principal('another-user', next.configuration.firebase.projectId),
        ip: '203.0.113.8',
      }),
    ).rejects.toMatchObject({ status: 429 })
    const globalKey = (await clientSecurityBucketKeys(principal(), '203.0.113.7')).global
    expect((await counters()).find((row) => row.bucket_key === globalKey)!.used).toBe(1)
  })

  it('creates an audited rollback revision without erasing consumption', async () => {
    const first = await save(configuration({ uid: 1 }))
    const admission = { principal: principal(), ip: '203.0.113.7' }
    await limiter.admit({ snapshot: first, ...admission })
    const second = await save(configuration({ uid: 2 }))
    await limiter.admit({ snapshot: second, ...admission })
    const before = await counters()
    const rolledBack = await store.save({
      expectedRevision: second.revision,
      configuration: first.configuration,
      reviewedDigest: first.digest,
      actor: 'payload-user:1',
      operation: 'rollback',
      rollbackRevision: first.revision,
    })
    expect(rolledBack).toEqual({ ...first, revision: second.revision + 1 })
    expect(await store.readVersion(rolledBack.revision)).toMatchObject({
      operation: 'rollback',
      actor: 'payload-user:1',
    })
    expect(await counters()).toEqual(before)
    await expect(limiter.admit({ snapshot: rolledBack, ...admission })).rejects.toMatchObject({
      status: 429,
    })
    expect(await counters()).toEqual(before)
  })

  it.each([
    ["UPDATE client_security_versions SET configuration = '{}' WHERE revision = 0"],
    ['UPDATE client_security_versions SET digest = ? WHERE revision = 0', '0'.repeat(64)],
    ['UPDATE client_security_state SET revision = 99 WHERE id = 1'],
  ])('fails closed on corrupt durable configuration: %s', async (sql, value?: string) => {
    await db
      .prepare(sql)
      .bind(...(value === undefined ? [] : [value]))
      .run()
    await expect(store.read()).rejects.toMatchObject({
      status: 503,
      reason: 'client_security_corrupt',
    })
    await expect(store.preview(configuration())).rejects.toMatchObject({ status: 503 })
  })

  it('fails closed on corrupt counters instead of repairing them into a fresh quota', async () => {
    const snapshot = await save(configuration())
    const admission = { snapshot, principal: principal(), ip: '203.0.113.7' }
    await limiter.admit(admission)
    const key = (await clientSecurityBucketKeys(admission.principal, admission.ip)).uid
    await db
      .prepare('UPDATE client_security_counters SET used = -1 WHERE bucket_key = ?')
      .bind(key)
      .run()
    const before = await counters()
    await expect(limiter.admit(admission)).rejects.toMatchObject({ status: 503 })
    expect(await counters()).toEqual(before)
  })

  it('returns unavailable when the counters table is absent and requires explicit initialization', async () => {
    const snapshot = await save(configuration())
    await db.prepare('DROP TABLE client_security_counters').run()
    try {
      await expect(
        limiter.admit({ snapshot, principal: principal(), ip: '203.0.113.7' }),
      ).rejects.toMatchObject({ status: 503 })
      expect(
        await db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'client_security_counters'",
          )
          .all(),
      ).toMatchObject({ results: [] })
    } finally {
      await initializeClientSecuritySchema(db)
    }
  })

  it('restricts actual admin settings GET and POST to a persisted Payload owner', async () => {
    for (const headers of [
      new Headers(),
      new Headers({ Authorization: `Bearer ${adminToken}` }),
      new Headers({ Authorization: `Bearer ${editorToken}` }),
      await runtime.fixture.headers({ collection: 'users', id: ownerId, role: 'owner' }),
    ]) {
      const response = await adminGet(new Request(adminUrl, { headers }))
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'client_security_owner_required' })
      headers.set('Origin', new URL(adminUrl).origin)
      headers.set('Content-Type', 'application/json')
      headers.set('X-Client-Security-Action', 'manage')
      const mutation = await adminPost(
        new Request(adminUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            action: 'preview',
            expectedRevision: 0,
            configuration: configuration(),
          }),
        }),
      )
      expect(mutation.status).toBe(403)
    }
    const response = await adminGet(
      new Request(adminUrl, { headers: { Authorization: `Bearer ${ownerToken}` } }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({
      snapshot: { revision: 0, configuration: DEFAULT_CLIENT_SECURITY_CONFIGURATION },
      readiness: { ready: false },
      history: [{ revision: 0, operation: 'initialize' }],
    })
  })

  it('reviews then saves through the actual owner API with durable actor metadata', async () => {
    const next = configuration()
    const previewResponse = await adminPost(
      adminRequest({ action: 'preview', expectedRevision: 0, configuration: next }),
    )
    expect(previewResponse.status).toBe(200)
    const preview = (await previewResponse.json()) as {
      digest: string
      currentRevision: number
      changes: { field: string }[]
    }
    expect(preview).toMatchObject({ currentRevision: 0, readiness: { ready: true } })
    expect(preview.changes.map((change) => change.field)).toContain('firebase.enabled')
    expect((await store.read()).revision).toBe(0)
    const saved = await adminPost(
      adminRequest({
        action: 'save',
        expectedRevision: 0,
        configuration: next,
        reviewedDigest: preview.digest,
      }),
    )
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      snapshot: { revision: 1, configuration: next, digest: preview.digest },
      readiness: { ready: true },
    })
    expect(await store.readVersion(1)).toMatchObject({
      actor: `users:${ownerId}`,
      operation: 'save',
    })
  })

  it('rejects missing, cross-origin, and cross-site owner mutation requests including signed cookies', async () => {
    const body = { action: 'preview', expectedRevision: 0, configuration: configuration() }
    const cases = [
      { Origin: '' },
      { Origin: 'https://untrusted.fixture.invalid' },
      { 'X-Client-Security-Action': '' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { Authorization: '', Cookie: `payload-token=${ownerToken}`, Origin: '' },
      {
        Authorization: '',
        Cookie: `payload-token=${ownerToken}`,
        Origin: 'https://untrusted.fixture.invalid',
      },
    ]
    for (const headers of cases) {
      const response = await adminPost(adminRequest(body, headers))
      expect(response.status).toBe(403)
      // Payload's CSRF origin list drops a cookie whose Origin is not trusted (including
      // an empty Origin) before the route runs, so those requests have no owner session.
      const cookieFromUntrustedOrigin =
        'Cookie' in headers && headers.Origin !== new URL(adminUrl).origin
      expect(await response.json()).toEqual({
        error: cookieFromUntrustedOrigin
          ? 'client_security_owner_required'
          : 'client_security_origin_required',
      })
    }
    const cookieRequest = await adminPost(
      adminRequest(body, { Authorization: '', Cookie: `payload-token=${ownerToken}` }),
    )
    expect(cookieRequest.status).toBe(200)
    expect((await store.read()).revision).toBe(0)
  })

  it('rejects unknown fields, injected actor or secret data, and unreviewed save requests', async () => {
    for (const body of [
      {
        action: 'preview',
        expectedRevision: 0,
        configuration: configuration(),
        actor: 'forged-owner',
      },
      {
        action: 'preview',
        expectedRevision: 0,
        configuration: { ...configuration(), serviceAccountKey: 'synthetic-forbidden-secret' },
      },
      {
        action: 'preview',
        expectedRevision: 0,
        configuration: {
          ...configuration(),
          firebase: { ...configuration().firebase, token: 'synthetic-token' },
        },
      },
      {
        action: 'save',
        expectedRevision: 0,
        configuration: configuration(),
        reviewedDigest: '0'.repeat(64),
      },
      { action: 'save', expectedRevision: 0, configuration: configuration() },
    ]) {
      const response = await adminPost(adminRequest(body))
      expect(response.status).toBe(400)
      expect(JSON.stringify(await response.json())).not.toContain('synthetic')
    }
    expect((await store.read()).revision).toBe(0)
    expect(await countRows('client_security_versions')).toBe(1)
  })

  it('gives exactly one actual API save winner and returns a reviewable stale conflict', async () => {
    const choices = [configuration({ uid: 2 }), configuration({ uid: 3 })]
    const digests = await Promise.all(
      choices.map(async (next) => {
        const response = await adminPost(
          adminRequest({ action: 'preview', expectedRevision: 0, configuration: next }),
        )
        expect(response.status).toBe(200)
        return ((await response.json()) as { digest: string }).digest
      }),
    )
    const results = await Promise.all(
      choices.map((next, index) =>
        adminPost(
          adminRequest({
            action: 'save',
            expectedRevision: 0,
            configuration: next,
            reviewedDigest: digests[index],
          }),
        ),
      ),
    )
    expect(results.map((response) => response.status).sort()).toEqual([200, 409])
    expect(await results.find((response) => response.status === 409)!.json()).toEqual({
      error: 'client_security_revision_conflict',
    })
    expect((await store.read()).revision).toBe(1)
  })

  it('previews and applies a historical rollback through the actual owner API without resetting quota usage', async () => {
    const first = await save(configuration({ uid: 2 }))
    await limiter.admit({ snapshot: first, principal: principal(), ip: '203.0.113.7' })
    const second = await save(configuration({ uid: 3 }))
    const before = await counters()
    const response = await adminPost(
      adminRequest({
        action: 'previewRollback',
        expectedRevision: second.revision,
        rollbackRevision: first.revision,
      }),
    )
    expect(response.status).toBe(200)
    const preview = (await response.json()) as { digest: string }
    expect(preview.digest).toBe(first.digest)
    const rollback = await adminPost(
      adminRequest({
        action: 'rollback',
        expectedRevision: second.revision,
        rollbackRevision: first.revision,
        reviewedDigest: preview.digest,
      }),
    )
    expect(rollback.status).toBe(200)
    expect(await rollback.json()).toMatchObject({
      snapshot: { revision: 3, digest: first.digest, configuration: first.configuration },
    })
    expect(await counters()).toEqual(before)
    expect(await store.readVersion(3)).toMatchObject({
      actor: `users:${ownerId}`,
      operation: 'rollback',
    })
  })

  it('denies a stale owner token immediately after the persisted role is demoted', async () => {
    await db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").bind(secondaryId).run()
    const secondOwner = await payload.findByID({ collection: 'users', id: secondaryId })
    const staleToken = (
      await payload.login({ collection: 'users', data: { email: secondOwner.email, password } })
    ).token!
    await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(secondaryId).run()
    expect(
      (
        await adminGet(
          new Request(adminUrl, { headers: { Authorization: `Bearer ${staleToken}` } }),
        )
      ).status,
    ).toBe(403)
    const mutation = await adminPost(
      adminRequest(
        { action: 'preview', expectedRevision: 0, configuration: configuration() },
        { Authorization: `Bearer ${staleToken}` },
      ),
    )
    expect(mutation.status).toBe(403)
    expect((await store.read()).revision).toBe(0)
  })

  it('preserves actual owner forgot-password and reset-password recovery without allowing fabricated recovery writes', async () => {
    const owner = await payload.findByID({ collection: 'users', id: ownerId })
    await expect(
      payload.update({
        collection: 'users',
        id: ownerId,
        overrideAccess: true,
        context: { clientSecurityRecovery: true, clientSecurityOwnerBootstrap: true },
        data: {
          resetPasswordToken: 'a'.repeat(40),
          resetPasswordExpiration: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    ).rejects.toMatchObject({ status: 403 })
    // Disable email explicitly: recovery executes locally without sending or logging a token.
    const resetToken = await payload.forgotPassword({
      collection: 'users',
      data: { email: owner.email },
      disableEmail: true,
    })
    if (typeof resetToken !== 'string' || !/^[a-f0-9]{40}$/.test(resetToken))
      throw new Error('Local recovery did not produce a reset token')
    const recoveredPassword = 'synthetic-recovered-integration-password'
    const recovered = await payload.resetPassword({
      collection: 'users',
      data: { password: recoveredPassword, token: resetToken },
      overrideAccess: false,
    })
    expect(recovered.user).toMatchObject({ id: ownerId, role: 'owner' })
    ownerToken = (
      await payload.login({
        collection: 'users',
        data: { email: owner.email, password: recoveredPassword },
      })
    ).token!
    const response = await adminGet(
      new Request(adminUrl, { headers: { Authorization: `Bearer ${ownerToken}` } }),
    )
    expect(response.status).toBe(200)
    expect((await store.read()).revision).toBe(0)
  })

  it('blocks real REST role self-promotion and owner credential takeover before field stripping', async () => {
    const admin = (
      await payload.find({
        collection: 'users',
        where: { email: { equals: 'security-admin@fixture.invalid' } },
        overrideAccess: true,
      })
    ).docs[0]
    const owner = await payload.findByID({ collection: 'users', id: ownerId })
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }
    for (const [id, data] of [
      [admin.id, { role: 'owner', context: { clientSecurityOwnerBootstrap: true } }],
      [ownerId, { password: 'synthetic-takeover-password', email: 'takeover@fixture.invalid' }],
      [ownerId, { role: 'admin' }],
    ] as const) {
      const response = await patch(
        new Request(`https://admin.fixture.invalid/api/users/${id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(data),
        }),
        params(['users', String(id)]),
      )
      expect(response.status).toBe(403)
    }
    const removeOwner = await remove(
      new Request(`https://admin.fixture.invalid/api/users/${ownerId}`, {
        method: 'DELETE',
        headers,
      }),
      params(['users', String(ownerId)]),
    )
    expect(removeOwner.status).toBe(403)
    expect(await payload.findByID({ collection: 'users', id: admin.id })).toMatchObject({
      role: 'admin',
    })
    expect(await payload.findByID({ collection: 'users', id: ownerId })).toMatchObject({
      role: 'owner',
      email: owner.email,
    })
    expect(
      (
        await adminGet(
          new Request(adminUrl, { headers: { Authorization: `Bearer ${ownerToken}` } }),
        )
      ).status,
    ).toBe(200)
  })

  it('preserves normal REST account updates when the submitted admin role is unchanged', async () => {
    const admin = (
      await payload.find({
        collection: 'users',
        where: { email: { equals: 'security-admin@fixture.invalid' } },
        overrideAccess: true,
      })
    ).docs[0]
    const updatedEmail = 'updated-security-admin@fixture.invalid'
    const response = await patch(
      new Request(`https://admin.fixture.invalid/api/users/${admin.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: updatedEmail, role: 'admin' }),
      }),
      params(['users', String(admin.id)]),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      doc: { id: admin.id, email: updatedEmail, role: 'admin' },
    })
    expect(await payload.findByID({ collection: 'users', id: admin.id })).toMatchObject({
      email: updatedEmail,
      role: 'admin',
    })
    expect(
      (
        await adminGet(
          new Request(adminUrl, { headers: { Authorization: `Bearer ${adminToken}` } }),
        )
      ).status,
    ).toBe(403)
  })

  it('keeps direct Payload REST and Local API security table writes blocked even for an owner', async () => {
    const headers = { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }
    const read = await get(
      new Request('https://admin.fixture.invalid/api/client-security-state', { headers }),
      params(['client-security-state']),
    )
    expect(read.status).toBe(200)
    for (const [method, handler, slug, data] of [
      ['POST', post, ['client-security-state'], { revision: 99 }],
      ['PATCH', patch, ['client-security-state', '1'], { revision: 99 }],
      ['DELETE', remove, ['client-security-state', '1'], undefined],
    ] as const) {
      const result = await handler(
        new Request(`https://admin.fixture.invalid/api/${slug.join('/')}`, {
          method,
          headers,
          body: data ? JSON.stringify(data) : undefined,
        }),
        params([...slug]),
      )
      expect(result.status).toBe(403)
    }
    await expect(
      payload.update({
        collection: 'client-security-state',
        id: 1,
        overrideAccess: true,
        data: { revision: 99 },
      }),
    ).rejects.toMatchObject({ status: 403 })
    expect((await store.read()).revision).toBe(0)
  })

  it.each(['delete', 'demote'] as const)(
    'atomically preserves a final owner when two owners concurrently %s',
    async (operation) => {
      const originalOwners = (
        await db.prepare("SELECT id FROM users WHERE role = 'owner'").all<{ id: number }>()
      ).results
      const candidates = await Promise.all(
        [1, 2].map((index) =>
          payload.create({
            collection: 'users',
            data: {
              email: `last-owner-${operation}-${index}@fixture.invalid`,
              password,
              role: 'admin',
            },
          }),
        ),
      )
      await db.batch(
        candidates.map((candidate) =>
          db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").bind(candidate.id),
        ),
      )
      await db.batch(
        originalOwners.map((user) =>
          db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(user.id),
        ),
      )
      try {
        const results = await Promise.allSettled(
          candidates.map((candidate) =>
            db
              .prepare(
                operation === 'delete'
                  ? 'DELETE FROM users WHERE id = ?'
                  : "UPDATE users SET role = 'admin' WHERE id = ?",
              )
              .bind(candidate.id)
              .run(),
          ),
        )
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
        const rejected = results.find((result) => result.status === 'rejected')
        if (rejected?.status === 'rejected')
          expect(String(rejected.reason)).toContain('last_owner_required')
        expect(
          await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'owner'").first(),
        ).toEqual({ count: 1 })
      } finally {
        await db.batch(
          originalOwners.map((user) =>
            db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").bind(user.id),
          ),
        )
        await db.batch(
          candidates.map((candidate) =>
            db.prepare('DELETE FROM users WHERE id = ?').bind(candidate.id),
          ),
        )
      }
    },
  )
})
