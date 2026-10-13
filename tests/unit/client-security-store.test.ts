import assert from 'node:assert/strict'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test from 'node:test'
import {
  canonicalClientSecurityConfiguration,
  DEFAULT_CLIENT_SECURITY_CONFIGURATION,
  digestClientSecurityConfiguration,
  type ClientSecurityConfiguration,
} from '../../src/client-security/schema'
import {
  ClientSecurityStoreError,
  createClientSecurityStore,
  type ClientSecurityDatabase,
  type ClientSecuritySnapshot,
} from '../../src/client-security/store'
import {
  canonicalClientSecurityIp,
  clientSecurityBucketKeys,
  ClientSecurityRateLimitError,
  createClientSecurityRateLimiter,
} from '../../src/client-security/rate-limits'

const NOW = Date.parse('2026-10-13T16:00:00Z')
const PROJECT = 'template-fixture',
  APP = '1:123456789:android:0123456789abcdef'
const principal = { uid: 'fixture-anonymous-user', projectId: PROJECT, appId: APP }
const IP = '203.0.113.7'
function config(
  limits: Partial<ClientSecurityConfiguration['limits']> = {},
): ClientSecurityConfiguration {
  return {
    schemaVersion: 1,
    firebase: { enabled: true, projectId: PROJECT, projectNumber: '123456789', appIds: [APP] },
    limits: { windowSeconds: 60, uid: 10, ip: 10, global: 10, ...limits },
  }
}

async function fixture(initial = DEFAULT_CLIENT_SECURITY_CONFIGURATION) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE client_security_state (id INTEGER PRIMARY KEY, revision NUMERIC NOT NULL,
    commit_nonce TEXT, admission_nonce TEXT, admission_allowed NUMERIC);
    CREATE TABLE client_security_versions (id INTEGER PRIMARY KEY, revision NUMERIC UNIQUE NOT NULL,
      configuration TEXT NOT NULL, digest TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE client_security_counters (id INTEGER PRIMARY KEY, bucket_key TEXT UNIQUE NOT NULL, used NUMERIC NOT NULL, reset_at NUMERIC NOT NULL);
    CREATE TABLE client_security_audit (id INTEGER PRIMARY KEY, revision NUMERIC NOT NULL, actor TEXT NOT NULL,
      operation TEXT NOT NULL, created_at TEXT NOT NULL, previous_revision NUMERIC NOT NULL);
    INSERT INTO client_security_state (id, revision) VALUES (1, 0);`)
  const digest = await digestClientSecurityConfiguration(initial)
  sqlite
    .prepare(
      `INSERT INTO client_security_versions (revision, configuration, digest, actor, operation, created_at)
    VALUES (0, ?, ?, 'system', 'initialize', ?)`,
    )
    .run(canonicalClientSecurityConfiguration(initial), digest, new Date(NOW).toISOString())
  interface Statement {
    bind(...values: SQLInputValue[]): Statement
    execute(): Record<string, unknown>[]
    first(): Promise<Record<string, unknown> | null>
    all(): Promise<{
      success: boolean
      results: Record<string, unknown>[]
      meta: { changes: number }
    }>
  }
  const prepared = (sql: string, values: SQLInputValue[] = []): Statement => ({
    bind: (...next) => prepared(sql, next),
    execute: () => sqlite.prepare(sql).all(...values) as Record<string, unknown>[],
    async first() {
      return (sqlite.prepare(sql).get(...values) as Record<string, unknown>) ?? null
    },
    async all() {
      return { success: true, results: this.execute(), meta: { changes: 0 } }
    },
  })
  const db = {
    prepare: prepared,
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map((statement) => ({
          success: true,
          results: statement.execute(),
          meta: { changes: Number(sqlite.prepare('SELECT changes() AS changed').get()!.changed) },
        }))
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as ClientSecurityDatabase
  let now = NOW
  const store = createClientSecurityStore(db, { nowMs: () => now })
  const limiter = createClientSecurityRateLimiter(db, { nowMs: () => now })
  const count = (table: string) =>
    Number(sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()!.total)
  const counters = () => {
    const statement = sqlite.prepare(
      'SELECT bucket_key, used, reset_at FROM client_security_counters ORDER BY bucket_key',
    )
    statement.setReadBigInts(true)
    return statement
      .all()
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            typeof value === 'bigint'
              ? value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
                ? Number(value)
                : value.toString()
              : value,
          ]),
        ),
      )
  }
  const save = async (
    configuration: ClientSecurityConfiguration,
    expectedRevision: number,
    operation: 'save' | 'rollback' = 'save',
    rollbackRevision?: number,
  ) =>
    store.save({
      configuration,
      expectedRevision,
      reviewedDigest: await digestClientSecurityConfiguration(configuration),
      actor: 'payload-user:7',
      operation,
      ...(rollbackRevision === undefined ? {} : { rollbackRevision }),
    })
  return {
    sqlite,
    db,
    store,
    limiter,
    count,
    counters,
    save,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
  }
}
async function rejectsStore(promise: Promise<unknown>, status: number, reason?: string) {
  await assert.rejects(
    promise,
    (error) =>
      error instanceof ClientSecurityStoreError &&
      error.status === status &&
      (!reason || error.reason === reason) &&
      error.message === error.reason,
  )
}
async function rejectsAdmission(promise: Promise<unknown>, status: number, retryAfter?: number) {
  await assert.rejects(
    promise,
    (error) =>
      error instanceof ClientSecurityRateLimitError &&
      error.status === status &&
      (retryAfter === undefined || error.retryAfter === retryAfter) &&
      error.message === error.reason,
  )
}
function admission(snapshot: ClientSecuritySnapshot, uid = principal.uid, ip = IP) {
  return { snapshot, principal: { ...principal, uid }, ip }
}

test('store reads and reviews canonical configuration without changing durable state', async () => {
  const f = await fixture(),
    snapshot = await f.store.read(),
    preview = await f.store.preview(config())
  assert.equal(snapshot.revision, 0)
  assert.deepEqual(snapshot.configuration, DEFAULT_CLIENT_SECURITY_CONFIGURATION)
  assert.equal(snapshot.digest, await digestClientSecurityConfiguration(snapshot.configuration))
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(preview.currentRevision, 0)
  assert.equal(preview.changed, true)
  assert.deepEqual(preview.readiness, { ready: true, reasons: [] })
  assert.equal(preview.canonical, canonicalClientSecurityConfiguration(config()))
  assert.equal(f.count('client_security_versions'), 1)
  assert.equal(f.count('client_security_audit'), 0)
})
test('successful CAS appends immutable version and audit with a commit witness', async () => {
  const f = await fixture(),
    saved = await f.save(config(), 0)
  assert.equal(saved.revision, 1)
  assert.deepEqual(await f.store.read(), saved)
  assert.equal(f.count('client_security_versions'), 2)
  const state = f.sqlite.prepare('SELECT * FROM client_security_state').get()!
  assert.match(String(state.commit_nonce), /^[0-9a-f-]{36}$/)
  assert.equal(state.admission_nonce, null)
  const audit = f.sqlite.prepare('SELECT * FROM client_security_audit').get()!
  assert.equal(audit.previous_revision, 0)
  assert.equal(audit.actor, 'payload-user:7')
  assert.equal(audit.operation, 'save')
  assert.equal((await f.store.readVersion(0)).operation, 'initialize')
  assert.equal((await f.store.history()).length, 2)
})
test('unreviewed settings are rejected before writing any state', async () => {
  const f = await fixture()
  await rejectsStore(
    f.store.save({
      expectedRevision: 0,
      configuration: config(),
      reviewedDigest: '0'.repeat(64),
      actor: 'payload-user:7',
      operation: 'save',
    }),
    400,
    'client_security_review_required',
  )
  assert.equal((await f.store.read()).revision, 0)
  assert.equal(f.count('client_security_audit'), 0)
})
test('concurrent CAS writers with the same expected revision have exactly one winner', async () => {
  const f = await fixture()
  const results = await Promise.allSettled([
    f.save(config({ uid: 2 }), 0),
    f.save(config({ uid: 3 }), 0),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
  assert.equal(failed.reason.status, 409)
  assert.equal(f.count('client_security_versions'), 2)
  assert.equal(f.count('client_security_audit'), 1)
})
test('audit failure rolls back the entire revision and version transaction', async () => {
  const f = await fixture()
  f.sqlite.exec(
    `CREATE TRIGGER reject_audit BEFORE INSERT ON client_security_audit BEGIN SELECT RAISE(ABORT, 'fixture private detail'); END`,
  )
  await rejectsStore(f.save(config(), 0), 503)
  assert.equal((await f.store.read()).revision, 0)
  assert.equal(f.count('client_security_versions'), 1)
  assert.equal(f.count('client_security_audit'), 0)
})
test('version corruption between review read and commit cannot be overwritten by CAS', async () => {
  const f = await fixture()
  const original = f.db.batch.bind(f.db)
  f.db.batch = async <T>(statements: D1PreparedStatement[]) => {
    f.sqlite
      .prepare('UPDATE client_security_versions SET digest = ? WHERE revision = 0')
      .run('0'.repeat(64))
    return original<T>(statements)
  }
  await rejectsStore(f.save(config(), 0), 503, 'client_security_corrupt')
  assert.equal(f.sqlite.prepare('SELECT revision FROM client_security_state').get()!.revision, 0)
  assert.equal(f.count('client_security_versions'), 1)
  assert.equal(f.count('client_security_audit'), 0)
})
test('rollback creates a new audited revision and preserves counters and prior versions', async () => {
  const f = await fixture(config()),
    active = await f.store.read()
  await f.limiter.admit(admission(active))
  const before = f.counters()
  await f.save(config({ uid: 2, windowSeconds: 10 }), 0)
  const restored = await f.save(config(), 1, 'rollback', 0)
  assert.equal(restored.revision, 2)
  assert.deepEqual(restored.configuration, config())
  assert.deepEqual(f.counters(), before)
  assert.equal(f.count('client_security_versions'), 3)
  const audit = f.sqlite
    .prepare('SELECT * FROM client_security_audit ORDER BY revision DESC LIMIT 1')
    .get()!
  assert.equal(audit.operation, 'rollback')
  assert.equal(audit.previous_revision, 1)
  await rejectsStore(
    f.save(config({ uid: 8 }), 2, 'rollback', 0),
    400,
    'client_security_review_required',
  )
  await rejectsStore(f.store.readVersion(99), 400, 'client_security_unknown_revision')
})
for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
  test(`invalid revision ${String(invalid)} never touches durable state`, async () => {
    const f = await fixture()
    await rejectsStore(f.save(config(), invalid), 400)
    assert.equal((await f.store.read()).revision, 0)
  })
}
test('history response is bounded without deleting historical versions', async () => {
  const f = await fixture()
  for (let index = 0; index < 24; index++) await f.save(config({ uid: index + 1 }), index)
  const history = await f.store.history()
  assert.equal(history.length, 20)
  assert.equal(history[0].revision, 24)
  assert.equal(history.at(-1)!.revision, 5)
  assert.equal(f.count('client_security_versions'), 25)
  await rejectsStore(f.store.history(21), 400)
  await rejectsStore(f.store.history(0), 400)
})
for (const [name, sql] of Object.entries({
  digest: `UPDATE client_security_versions SET digest = '${'0'.repeat(64)}'`,
  unknownField: `UPDATE client_security_versions SET configuration = '{"token":"never allowed"}'`,
  malformedJson: `UPDATE client_security_versions SET configuration = '{'`,
  missingVersion: 'DELETE FROM client_security_versions',
  badRevision: 'UPDATE client_security_state SET revision = 0.5',
})) {
  test(`configuration ${name} corruption fails closed`, async () => {
    const f = await fixture()
    f.sqlite.exec(sql)
    await rejectsStore(f.store.read(), 503)
    await rejectsStore(f.save(config(), 0), 503)
    assert.equal(f.count('client_security_audit'), 0)
  })
}
test('missing schema or state is unavailable and never initialized by runtime code', async () => {
  const f = await fixture()
  f.sqlite.exec('DROP TABLE client_security_versions')
  await rejectsStore(f.store.read(), 503)
  assert.equal(
    f.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE name = 'client_security_versions'")
      .get(),
    undefined,
  )
  const second = await fixture()
  second.sqlite.exec('DELETE FROM client_security_state')
  await rejectsStore(second.store.read(), 503)
  assert.equal(second.count('client_security_state'), 0)
})

test('bucket keys hash identities, separate accounts/projects, and canonicalize IPv6', async () => {
  const first = await clientSecurityBucketKeys(principal, IP)
  const second = await clientSecurityBucketKeys({ ...principal, uid: 'another-account' }, IP)
  const third = await clientSecurityBucketKeys({ ...principal, projectId: 'another-project' }, IP)
  for (const key of Object.values(first)) assert.match(key, /^[0-9a-f]{64}$/)
  assert.notEqual(first.uid, second.uid)
  assert.notEqual(first.uid, third.uid)
  assert.equal(first.ip, third.ip)
  assert.equal(first.global, third.global)
  assert.deepEqual(
    await clientSecurityBucketKeys(principal, '2001:0db8:0:0:0:0:0:1'),
    await clientSecurityBucketKeys(principal, '2001:db8::1'),
  )
  assert.equal(canonicalClientSecurityIp('::FFFF:192.0.2.1'), '::ffff:c000:201')
})
for (const ip of [
  ':::',
  '127.1',
  '001.2.3.4',
  '999.2.3.4',
  'http://attacker.test',
  '203.0.113.7:80',
  '[::1]',
  '::1%eth0',
  '',
]) {
  test(`unusable trusted IP ${JSON.stringify(ip)} is unavailable`, () => {
    assert.throws(
      () => canonicalClientSecurityIp(ip),
      (error) => error instanceof ClientSecurityRateLimitError && error.status === 503,
    )
  })
}
test('admission charges all three dimensions once with private hashed keys', async () => {
  const f = await fixture(config()),
    active = await f.store.read()
  const result = await f.limiter.admit(admission(active))
  assert.equal(result.allowed, true)
  assert.deepEqual(result.remaining, { uid: 9, ip: 9, global: 9 })
  assert.deepEqual(result.resetAt, {
    uid: NOW / 1000 + 60,
    ip: NOW / 1000 + 60,
    global: NOW / 1000 + 60,
  })
  assert.equal(Object.isFrozen(result.remaining), true)
  assert.equal(f.count('client_security_counters'), 3)
  assert.ok(f.counters().every((row) => row.used === 1))
  assert.equal(JSON.stringify(f.counters()).includes(principal.uid), false)
  assert.equal(JSON.stringify(f.counters()).includes(IP), false)
})
for (const dimension of ['uid', 'ip', 'global'] as const) {
  test(`${dimension} exhaustion rejects atomically without charging or creating other buckets`, async () => {
    const f = await fixture(config({ uid: 100, ip: 100, global: 100, [dimension]: 1 })),
      active = await f.store.read()
    await f.limiter.admit(admission(active))
    const before = f.counters()
    await rejectsAdmission(
      f.limiter.admit(
        admission(
          active,
          dimension === 'uid' ? principal.uid : 'fresh-user',
          dimension === 'global' ? '203.0.113.8' : IP,
        ),
      ),
      429,
      60,
    )
    assert.deepEqual(f.counters(), before)
  })
}
test('parallel admissions cannot overshoot the smallest dimension', async () => {
  const f = await fixture(config({ uid: 7, ip: 10, global: 12 })),
    active = await f.store.read()
  const results = await Promise.allSettled(
    Array.from({ length: 50 }, () => f.limiter.admit(admission(active))),
  )
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 7)
  assert.ok(
    results
      .filter((result) => result.status === 'rejected')
      .every((result) => result.reason.status === 429),
  )
  assert.ok(f.counters().every((row) => row.used === 7))
})
test('blocked anonymous identities do not grow the counter table', async () => {
  const f = await fixture(config({ ip: 1, global: 1 })),
    active = await f.store.read()
  await f.limiter.admit(admission(active))
  const before = f.counters()
  for (let index = 0; index < 25; index++)
    await rejectsAdmission(
      f.limiter.admit(admission(active, `fresh-user-${index}`, '203.0.113.8')),
      429,
    )
  assert.deepEqual(f.counters(), before)
})
test('current decreased limits apply to consumed counters and stale snapshots cannot admit', async () => {
  const f = await fixture(config()),
    active = await f.store.read()
  await f.limiter.admit(admission(active))
  await f.limiter.admit(admission(active))
  const before = f.counters(),
    changed = await f.save(config({ uid: 1 }), 0)
  await rejectsAdmission(f.limiter.admit(admission(active)), 503)
  await rejectsAdmission(f.limiter.admit(admission(changed)), 429)
  assert.deepEqual(f.counters(), before)
})
test('new window length takes effect only after existing reset deadlines expire', async () => {
  const f = await fixture(config()),
    active = await f.store.read()
  await f.limiter.admit(admission(active))
  f.advance(30_000)
  const changed = await f.save(config({ windowSeconds: 10 }), 0)
  const second = await f.limiter.admit(admission(changed))
  assert.deepEqual(second.resetAt, {
    uid: NOW / 1000 + 60,
    ip: NOW / 1000 + 60,
    global: NOW / 1000 + 60,
  })
  assert.ok(f.counters().every((row) => row.used === 2))
  f.advance(30_000)
  const third = await f.limiter.admit(admission(changed))
  assert.deepEqual(third.remaining, { uid: 9, ip: 9, global: 9 })
  assert.deepEqual(third.resetAt, {
    uid: NOW / 1000 + 70,
    ip: NOW / 1000 + 70,
    global: NOW / 1000 + 70,
  })
})
test('a rejected decision does not reset an expired independent bucket', async () => {
  const f = await fixture(config({ global: 1 })),
    active = await f.store.read()
  await f.limiter.admit(admission(active))
  const keys = await clientSecurityBucketKeys(principal, IP)
  f.sqlite
    .prepare('UPDATE client_security_counters SET reset_at = ? WHERE bucket_key = ?')
    .run(NOW / 1000 - 1, keys.uid)
  const before = f.counters()
  await rejectsAdmission(f.limiter.admit(admission(active)), 429, 60)
  assert.deepEqual(f.counters(), before)
})
test('disabled configuration and replaced trust cannot charge stale requests', async () => {
  const f = await fixture(config()),
    active = await f.store.read()
  const disabled = { ...config(), firebase: { ...config().firebase, enabled: false } }
  const changed = await f.save(disabled, 0)
  await rejectsAdmission(f.limiter.admit(admission(active)), 503)
  await rejectsAdmission(f.limiter.admit(admission(changed)), 503)
  assert.equal(f.count('client_security_counters'), 0)
})
for (const [name, sql] of Object.entries({
  negativeUsed: 'used = -1',
  fractionalUsed: 'used = 0.5',
  stringUsed: "used = 'invalid'",
  negativeReset: 'reset_at = -1',
  fractionalReset: 'reset_at = 0.5',
  stringReset: "reset_at = 'invalid'",
  unsafeUsed: 'used = 9007199254740992',
  unsafeReset: 'reset_at = 9007199254740992',
})) {
  test(`corrupt counter ${name} fails closed without mutating other counters`, async () => {
    const f = await fixture(config()),
      active = await f.store.read()
    await f.limiter.admit(admission(active))
    const keys = await clientSecurityBucketKeys(principal, IP)
    f.sqlite
      .prepare(`UPDATE client_security_counters SET ${sql} WHERE bucket_key = ?`)
      .run(keys.uid)
    const before = f.counters()
    await rejectsAdmission(f.limiter.admit(admission(active)), 503)
    assert.deepEqual(f.counters(), before)
  })
}
test('version digest corruption or missing counter schema never admits', async () => {
  const f = await fixture(config()),
    active = await f.store.read()
  f.sqlite.exec(`UPDATE client_security_versions SET digest = '${'0'.repeat(64)}'`)
  await rejectsAdmission(f.limiter.admit(admission(active)), 503)
  assert.equal(f.count('client_security_counters'), 0)
  const second = await fixture(config()),
    other = await second.store.read()
  second.sqlite.exec('DROP TABLE client_security_counters')
  await rejectsAdmission(second.limiter.admit(admission(other)), 503)
})
test('unexpected storage faults are sanitized and roll back counter charges', async () => {
  const f = await fixture(config()),
    active = await f.store.read()
  f.sqlite.exec(
    `CREATE TRIGGER reject_increment BEFORE UPDATE ON client_security_counters BEGIN SELECT RAISE(ABORT, 'fixture private detail'); END`,
  )
  await rejectsAdmission(f.limiter.admit(admission(active)), 503)
  assert.equal(f.count('client_security_counters'), 0)
  assert.equal(
    f.sqlite.prepare('SELECT admission_nonce FROM client_security_state').get()!.admission_nonce,
    null,
  )
})
