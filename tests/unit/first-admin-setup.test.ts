import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { Payload, PayloadRequest } from 'payload'

import { allowsUserCreation, guardPublicUserCreation } from '../../src/auth/first-admin'
import {
  createFirstAdminAccount,
  createSetupState,
  FIRST_ADMIN_SETUP_CONTEXT,
  isSameOriginSetupRequest,
  SETUP_CLAIM_TTL_MS,
  validateFirstAdminInput,
  type SetupStateDatabase,
} from '../../src/auth/first-admin-setup'
import { throttleAuthOperation } from '../../src/auth/login-throttle'
import { createFirstAdmin } from '../../scripts/create-first-admin.mjs'

const SUPER_ADMIN_ID = 7

/** Real SQLite with the D1 calling convention, so the setup SQL runs as written. */
function sqliteDatabase() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE users (id integer PRIMARY KEY NOT NULL, email text NOT NULL UNIQUE, roles text);
    CREATE TABLE setup_state (id integer PRIMARY KEY NOT NULL, singleton text NOT NULL,
      claim_token text, claimed_at numeric, completed_at numeric);
    CREATE UNIQUE INDEX setup_state_singleton_idx ON setup_state (singleton);
  `)
  // node:sqlite binds `?NNN` placeholders only by name, so map them to `$pNNN`.
  const named = (query: string) => query.replace(/\?(\d+)/g, '$p$1')
  const params = (values: unknown[]) =>
    Object.fromEntries(values.map((value, index) => [`p${index + 1}`, value])) as never
  const db: SetupStateDatabase = {
    prepare: (query) => ({
      bind: (...values) => ({
        first: async <T>() =>
          (sqlite.prepare(named(query)).get(params(values)) ?? null) as T | null,
        run: async () => sqlite.prepare(named(query)).run(params(values)),
      }),
    }),
  }
  return { sqlite, db }
}

function fakePayload(
  sqlite: DatabaseSync,
  db: SetupStateDatabase,
  { failRoleUpdate = false }: { failRoleUpdate?: boolean } = {},
) {
  const logs: unknown[] = []
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const payload = {
    db: {
      binding: db,
      deleteMany: async ({ where }: { where: { email: { equals: string } } }) => {
        sqlite.prepare('DELETE FROM users WHERE email = ?').run(where.email.equals)
      },
    },
    find: async () => ({
      docs: [{ id: SUPER_ADMIN_ID, slug: 'super-admin', grantsFullAccess: true }],
    }),
    create: async ({ data }: { data: { email: string } }) => {
      await tick()
      const row = sqlite
        .prepare('INSERT INTO users (email, roles) VALUES (?, ?) RETURNING id')
        .get(data.email, '[]') as { id: number }
      return { id: row.id }
    },
    findByID: async ({ id }: { id: number }) => {
      await tick()
      const row = sqlite.prepare('SELECT roles FROM users WHERE id = ?').get(id) as {
        roles: string
      }
      return { id, roles: JSON.parse(row.roles) }
    },
    update: async ({ id, data }: { id: number; data: { roles: number[] } }) => {
      if (failRoleUpdate) throw new Error('role update failed')
      sqlite.prepare('UPDATE users SET roles = ? WHERE id = ?').run(JSON.stringify(data.roles), id)
    },
    logger: { info: (entry: unknown) => logs.push(entry) },
  }
  return { payload: payload as unknown as Payload, logs }
}

const password = 'first-admin-password-123'

test('only one claim succeeds while users is empty and none is live', async () => {
  const { db, sqlite } = sqliteDatabase()
  let now = 1_000_000
  const state = createSetupState(db, { nowMs: () => now })
  const results = await Promise.all(['a', 'b', 'c'].map((token) => state.claim(token)))
  assert.deepEqual(results.filter(Boolean).length, 1)
  assert.equal(await state.claim('d'), false)
  // An unfinished claim can be taken over once it is older than the TTL.
  now += SETUP_CLAIM_TTL_MS
  assert.equal(await state.claim('e'), true)
  await state.release('e')
  assert.equal(await state.claim('f'), true)
  // Users present: no claim, for the web flow or the CLI.
  await state.release('f')
  sqlite.prepare("INSERT INTO users (email) VALUES ('x@example.com')").run()
  assert.equal(await state.claim('g'), false)
  assert.equal(await state.claim('h', { afterCompletion: true }), false)
})

test('completion is permanent for the web flow; the CLI can recover an empty table', async () => {
  const { db, sqlite } = sqliteDatabase()
  const state = createSetupState(db)
  assert.equal(await state.claim('a'), true)
  assert.equal(await state.complete('b'), false)
  assert.equal(await state.complete('a'), true)
  assert.equal(await state.completed(), true)
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM users').get()?.n, 0)
  assert.equal(await state.claim('c'), false)
  assert.equal(await state.claim('d', { afterCompletion: true }), true)
  assert.equal(await state.complete('d'), true)
  assert.equal(await state.completed(), true)
})

test('seal records completion only when users already exist', async () => {
  const { db, sqlite } = sqliteDatabase()
  const state = createSetupState(db)
  await state.seal()
  assert.equal(await state.completed(), false)
  sqlite.prepare("INSERT INTO users (email) VALUES ('x@example.com')").run()
  await state.seal()
  assert.equal(await state.completed(), true)
  sqlite.prepare('DELETE FROM users').run()
  assert.equal(await state.claim('a'), false)
})

test('concurrent CLI runs create one user and that user is Super Admin', async () => {
  const { db, sqlite } = sqliteDatabase()
  const { payload, logs } = fakePayload(sqlite, db)
  const results = await Promise.allSettled([
    createFirstAdmin(payload, { email: 'one@example.com', password }),
    createFirstAdmin(payload, { email: 'two@example.org', password }),
  ])
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal((rejected[0] as PromiseRejectedResult).reason.status, 409)
  const users = sqlite.prepare('SELECT email, roles FROM users').all() as Array<{
    email: string
    roles: string
  }>
  assert.equal(users.length, 1)
  assert.deepEqual(JSON.parse(users[0].roles), [SUPER_ADMIN_ID])
  assert.equal(await createSetupState(db).completed(), true)
  assert.equal(logs.length, 1)
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(password))
  assert.match(JSON.stringify(logs), /"emailDomain":"example\.(com|org)"/)
  assert.doesNotMatch(JSON.stringify(logs), /one@|two@/)
})

test('a failed setup removes its user and releases the claim', async () => {
  const { db, sqlite } = sqliteDatabase()
  const failing = fakePayload(sqlite, db, { failRoleUpdate: true })
  await assert.rejects(
    createFirstAdminAccount(
      failing.payload,
      { email: 'one@example.com', password },
      { source: 'web', req: { context: {}, t: (key: string) => key } as unknown as PayloadRequest },
    ),
    /role update failed/,
  )
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM users').get()?.n, 0)
  assert.equal(await createSetupState(db).completed(), false)
  const { payload } = fakePayload(sqlite, db)
  const req = { context: {}, t: (key: string) => key } as unknown as PayloadRequest
  await createFirstAdminAccount(
    payload,
    { email: 'two@example.com', password },
    { source: 'web', req },
  )
  assert.equal(req.context[FIRST_ADMIN_SETUP_CONTEXT], undefined)
  await assert.rejects(
    createFirstAdminAccount(
      payload,
      { email: 'three@example.com', password },
      { source: 'web', req },
    ),
    (error: { status?: number }) => error.status === 403,
  )
})

test('users creation is allowed inside an active setup claim only', () => {
  const rest = { payloadAPI: 'REST', user: null } as Pick<PayloadRequest, 'payloadAPI' | 'user'>
  assert.equal(allowsUserCreation(rest, { [FIRST_ADMIN_SETUP_CONTEXT]: 'token' }), true)
  assert.equal(allowsUserCreation(rest, { [FIRST_ADMIN_SETUP_CONTEXT]: '' }), false)
  assert.equal(allowsUserCreation(rest, {}), false)
  const req = { ...rest, t: (key: string) => key } as unknown as PayloadRequest
  const args = { args: {}, operation: 'create', req } as unknown as Parameters<
    typeof guardPublicUserCreation
  >[0]
  assert.throws(() => guardPublicUserCreation({ ...args, context: {} }))
  assert.deepEqual(
    guardPublicUserCreation({ ...args, context: { [FIRST_ADMIN_SETUP_CONTEXT]: 'token' } }),
    {},
  )
})

test('setup input needs a valid email and a 12-character password', () => {
  assert.deepEqual(validateFirstAdminInput(' a@example.com ', password), {
    email: 'a@example.com',
    password,
  })
  assert.throws(() => validateFirstAdminInput('nope', password), { status: 400 } as never)
  assert.throws(() => validateFirstAdminInput('a@example.com', 'short'), { status: 400 } as never)
  assert.throws(() => validateFirstAdminInput(undefined, undefined), { status: 400 } as never)
})

test('setup requests must come from the admin origin', () => {
  const request = (headers: Record<string, string>) =>
    ({
      url: 'https://admin.example.com/api/users/first-register',
      headers: new Headers(headers),
      payload: { config: { csrf: ['https://cms.example.com'] } },
    }) as unknown as PayloadRequest
  assert.equal(isSameOriginSetupRequest(request({})), true)
  assert.equal(isSameOriginSetupRequest(request({ origin: 'https://admin.example.com' })), true)
  assert.equal(isSameOriginSetupRequest(request({ origin: 'https://cms.example.com' })), true)
  assert.equal(isSameOriginSetupRequest(request({ origin: 'https://other.example.net' })), false)
  assert.equal(isSameOriginSetupRequest(request({ 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(isSameOriginSetupRequest(request({ 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(isSameOriginSetupRequest(request({ 'sec-fetch-site': 'same-site' })), false)
})

test('refresh with a valid session is not counted by the auth throttle', async () => {
  let writes = 0
  const binding: SetupStateDatabase = {
    prepare: () => ({
      bind: () => ({
        first: async <T>() => {
          writes += 1
          return { used: 1, reset_at: Date.now() + 1000 } as T
        },
        run: async () => {
          writes += 1
          return {}
        },
      }),
    }),
  }
  const req = (user: unknown) =>
    ({
      payloadAPI: 'REST',
      user,
      headers: new Headers({ 'cf-connecting-ip': '192.0.2.5' }),
      payload: { db: { binding } },
    }) as unknown as PayloadRequest
  const args = (r: PayloadRequest) =>
    ({ args: {}, operation: 'refresh', req: r }) as unknown as Parameters<
      typeof throttleAuthOperation
    >[0]
  await throttleAuthOperation(args(req({ id: 1 })))
  assert.equal(writes, 0)
  await throttleAuthOperation(args(req(null)))
  assert.ok(writes > 0)
})
