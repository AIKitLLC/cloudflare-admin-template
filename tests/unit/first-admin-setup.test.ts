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
  SETUP_GUARD_TRIGGER_SQL,
  validateFirstAdminInput,
  type SetupStateDatabase,
} from '../../src/auth/first-admin-setup'
import { throttleAuthOperation } from '../../src/auth/login-throttle'
import { createFirstAdmin } from '../../scripts/create-first-admin.mjs'
import { SETUP_GUARD_TRIGGER_SQL as MIGRATION_GUARD_SQL } from '../../src/migrations/20261017_144000_setup_state'

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
  {
    failRoleUpdate = false,
    failDelete = false,
    beforeInsert,
    afterInsert,
  }: {
    failRoleUpdate?: boolean
    failDelete?: boolean
    beforeInsert?: (email: string) => Promise<void>
    afterInsert?: (email: string) => Promise<void>
  } = {},
) {
  const logs: unknown[] = []
  const deletes: unknown[] = []
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const payload = {
    db: {
      binding: db,
      deleteMany: async ({ where }: { where: { id?: { equals: number } } }) => {
        deletes.push(where)
        // Only deletion by id is supported, so a cleanup by any other field fails the test.
        if (!where.id) throw new Error(`unexpected delete: ${JSON.stringify(where)}`)
        if (failDelete) throw new Error('delete failed')
        sqlite.prepare('DELETE FROM users WHERE id = ?').run(where.id.equals)
      },
    },
    find: async () => ({
      docs: [{ id: SUPER_ADMIN_ID, slug: 'super-admin', grantsFullAccess: true }],
    }),
    create: async ({ data }: { data: { email: string } }) => {
      await tick()
      await beforeInsert?.(data.email)
      const row = sqlite
        .prepare('INSERT INTO users (email, roles) VALUES (?, ?) RETURNING id')
        .get(data.email.toLowerCase(), '[]') as { id: number }
      await afterInsert?.(data.email)
      return { id: row.id }
    },
    findByID: async ({ id }: { id: number }) => {
      await tick()
      const row = sqlite.prepare('SELECT email, roles FROM users WHERE id = ?').get(id) as {
        email: string
        roles: string
      }
      return { id, email: row.email, roles: JSON.parse(row.roles) }
    },
    update: async ({ id, data }: { id: number; data: { roles: number[] } }) => {
      if (failRoleUpdate) throw new Error('role update failed')
      sqlite.prepare('UPDATE users SET roles = ? WHERE id = ?').run(JSON.stringify(data.roles), id)
    },
    logger: { info: (entry: unknown) => logs.push(entry) },
  }
  return { payload: payload as unknown as Payload, logs, deletes }
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
  sqlite.prepare("INSERT INTO users (email) VALUES ('first@example.com')").run()
  assert.equal(await state.complete('b'), false)
  assert.equal(await state.complete('a'), true)
  assert.equal(await state.completed(), true)
  sqlite.prepare('DELETE FROM users').run()
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM users').get()?.n, 0)
  assert.equal(await state.claim('c'), false)
  assert.equal(await state.claim('d', { afterCompletion: true }), true)
  sqlite.prepare("INSERT INTO users (email) VALUES ('again@example.com')").run()
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
  // No Origin: only Sec-Fetch-Site same-origin or a Referer on an allowed origin passes.
  assert.equal(isSameOriginSetupRequest(request({})), false)
  assert.equal(isSameOriginSetupRequest(request({ 'sec-fetch-site': 'none' })), false)
  assert.equal(
    isSameOriginSetupRequest(
      request({ referer: 'https://admin.example.com/admin/create-first-user' }),
    ),
    true,
  )
  assert.equal(
    isSameOriginSetupRequest(request({ referer: 'https://cms.example.com/admin' })),
    true,
  )
  assert.equal(
    isSameOriginSetupRequest(request({ referer: 'https://other.example.net/admin' })),
    false,
  )
  assert.equal(isSameOriginSetupRequest(request({ referer: 'not a url' })), false)
  assert.equal(
    isSameOriginSetupRequest(
      request({ 'sec-fetch-site': 'cross-site', referer: 'https://admin.example.com/admin' }),
    ),
    false,
  )
  assert.equal(
    isSameOriginSetupRequest(
      request({ origin: 'https://other.example.net', referer: 'https://admin.example.com/admin' }),
    ),
    false,
  )
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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

const webReq = () => ({ context: {}, t: (key: string) => key }) as unknown as PayloadRequest
const expireClaims = (sqlite: DatabaseSync) =>
  sqlite
    .prepare('UPDATE setup_state SET claimed_at = claimed_at - ?')
    .run(SETUP_CLAIM_TTL_MS + 1000)
const userRows = (sqlite: DatabaseSync) =>
  sqlite.prepare('SELECT id, email, roles FROM users ORDER BY id').all() as Array<{
    id: number
    email: string
    roles: string
  }>

test('the migration installs the same guard trigger as the runtime', () => {
  assert.equal(MIGRATION_GUARD_SQL, SETUP_GUARD_TRIGGER_SQL)
})

test('a claim that was taken over can no longer be held', async () => {
  const { db, sqlite } = sqliteDatabase()
  let now = 1_000_000
  const state = createSetupState(db, { nowMs: () => now })
  assert.equal(await state.claim('a'), true)
  assert.equal(await state.hold('a'), true)
  now += SETUP_CLAIM_TTL_MS + 1
  assert.equal(await state.hold('a'), false)
  assert.equal(await state.claim('b'), true)
  assert.equal(await state.hold('a'), false)
  assert.equal(await state.hold('b'), true)
  sqlite.prepare("INSERT INTO users (email) VALUES ('x@example.com')").run()
  assert.equal(await state.hold('b'), false)
})

test('the guard trigger refuses a second user while a claim is live', async () => {
  const { db, sqlite } = sqliteDatabase()
  const state = createSetupState(db)
  await state.installGuard()
  await state.installGuard()
  assert.equal(await state.claim('a'), true)
  sqlite.prepare("INSERT INTO users (email) VALUES ('one@example.com')").run()
  assert.throws(
    () => sqlite.prepare("INSERT INTO users (email) VALUES ('two@example.com')").run(),
    /first-run setup already created a user/,
  )
  // Payload's update path is an upsert on the existing id; it must still work.
  sqlite
    .prepare(
      "INSERT INTO users (id, email, roles) VALUES (1, 'one@example.com', '[7]') ON CONFLICT(id) DO UPDATE SET roles = excluded.roles",
    )
    .run()
  assert.equal(userRows(sqlite)[0].roles, '[7]')
  assert.throws(
    () =>
      sqlite
        .prepare(
          "INSERT INTO users (id, email) VALUES (2, 'two@example.com') ON CONFLICT(id) DO UPDATE SET email = excluded.email",
        )
        .run(),
    /first-run setup already created a user/,
  )
  assert.equal(await state.complete('a'), true)
  // After completion the guard is inactive and admins can add users.
  sqlite.prepare("INSERT INTO users (email) VALUES ('two@example.com')").run()
  assert.equal(userRows(sqlite).length, 2)
})

test('two concurrent setups over a taken-over claim create one Super Admin (guard path)', async () => {
  const { db, sqlite } = sqliteDatabase()
  const aReady = deferred()
  const aGo = deferred()
  const bInserted = deferred()
  const bGo = deferred()
  const { payload, deletes } = fakePayload(sqlite, db, {
    beforeInsert: async (email) => {
      if (email !== 'a@example.com') return
      aReady.resolve()
      await aGo.promise
    },
    afterInsert: async (email) => {
      if (email !== 'b@example.com') return
      bInserted.resolve()
      await bGo.promise
    },
  })
  const a = createFirstAdminAccount(
    payload,
    { email: 'a@example.com', password },
    {
      source: 'web',
      req: webReq(),
    },
  )
  await aReady.promise
  expireClaims(sqlite)
  const b = createFirstAdminAccount(
    payload,
    { email: 'b@example.com', password },
    {
      source: 'web',
      req: webReq(),
    },
  )
  await bInserted.promise
  aGo.resolve()
  await assert.rejects(a, (error: { status?: number }) => error.status === 403)
  bGo.resolve()
  await b
  const users = userRows(sqlite)
  assert.deepEqual(
    users.map((user) => [user.email, JSON.parse(user.roles)]),
    [['b@example.com', [SUPER_ADMIN_ID]]],
  )
  assert.deepEqual(deletes, [])
  assert.equal(await createSetupState(db).completed(), true)
})

test('two concurrent setups over a taken-over claim create one Super Admin (completion path)', async () => {
  const { db, sqlite } = sqliteDatabase()
  const aReady = deferred()
  const aGo = deferred()
  const { payload, deletes } = fakePayload(sqlite, db, {
    beforeInsert: async (email) => {
      if (email !== 'a@example.com') return
      aReady.resolve()
      await aGo.promise
    },
  })
  const a = createFirstAdminAccount(
    payload,
    { email: 'a@example.com', password },
    {
      source: 'web',
      req: webReq(),
    },
  )
  await aReady.promise
  expireClaims(sqlite)
  const b = await createFirstAdminAccount(
    payload,
    { email: 'b@example.com', password },
    {
      source: 'web',
      req: webReq(),
    },
  )
  aGo.resolve()
  await assert.rejects(a, (error: { status?: number }) => error.status === 409)
  const users = userRows(sqlite)
  assert.deepEqual(
    users.map((user) => [user.id, user.email, JSON.parse(user.roles)]),
    [[b.id, 'b@example.com', [SUPER_ADMIN_ID]]],
  )
  // The failed request removed only its own row, by id.
  assert.equal(deletes.length, 1)
  assert.notEqual((deletes[0] as { id: { equals: number } }).id.equals, b.id)
})

test("a failed setup never removes another request's account with the same email", async () => {
  const { db, sqlite } = sqliteDatabase()
  const aReady = deferred()
  const aGo = deferred()
  let calls = 0
  const { payload, deletes } = fakePayload(sqlite, db, {
    beforeInsert: async () => {
      calls += 1
      if (calls !== 1) return
      aReady.resolve()
      await aGo.promise
    },
  })
  const a = createFirstAdminAccount(
    payload,
    { email: 'same@example.com', password },
    {
      source: 'web',
      req: webReq(),
    },
  )
  await aReady.promise
  expireClaims(sqlite)
  const b = await createFirstAdminAccount(
    payload,
    { email: 'same@example.com', password },
    {
      source: 'web',
      req: webReq(),
    },
  )
  aGo.resolve()
  await assert.rejects(a)
  assert.deepEqual(deletes, [])
  assert.deepEqual(
    userRows(sqlite).map((user) => [user.id, JSON.parse(user.roles)]),
    [[b.id, [SUPER_ADMIN_ID]]],
  )
})

test('a failed setup with a mixed-case email removes the account it created', async () => {
  const { db, sqlite } = sqliteDatabase()
  const { payload, deletes } = fakePayload(sqlite, db, { failRoleUpdate: true })
  await assert.rejects(
    createFirstAdminAccount(
      payload,
      { email: 'Mixed.Case@Example.COM', password },
      { source: 'web', req: webReq() },
    ),
    /role update failed/,
  )
  assert.equal(userRows(sqlite).length, 0)
  assert.equal(deletes.length, 1)
  assert.equal(await createSetupState(db).completed(), false)
  // The claim was released, so setup can be retried.
  assert.equal(await createSetupState(db).claim('retry'), true)
})

/** Simulates an attempt that claimed setup, created its user, then died before completing. */
async function interruptedSetup(sqlite: DatabaseSync, db: SetupStateDatabase, email: string) {
  const state = createSetupState(db)
  assert.equal(await state.claim('dead-attempt'), true)
  sqlite.prepare('INSERT INTO users (email, roles) VALUES (?, ?)').run(email, '[]')
}

/** Setup completed once, then every user was removed: the state `admin:create` recovers. */
async function completedThenEmptied(sqlite: DatabaseSync, db: SetupStateDatabase) {
  sqlite.prepare("INSERT INTO users (email, roles) VALUES ('old@example.com', '[]')").run()
  await createSetupState(db).seal()
  sqlite.prepare('DELETE FROM users').run()
}

const claimToken = (sqlite: DatabaseSync) =>
  (sqlite.prepare('SELECT claim_token FROM setup_state').get() as { claim_token: string | null })
    .claim_token

test('a setup whose create failed after the insert removes that user', async () => {
  // D1 runs without transactions: the row is committed before the `users` hooks run, so a
  // hook failure rejects `create` with the row already stored.
  const { db, sqlite } = sqliteDatabase()
  await completedThenEmptied(sqlite, db)
  const { payload, deletes } = fakePayload(sqlite, db, {
    afterInsert: async () => {
      throw new Error('D1_ERROR: database is locked')
    },
  })
  await assert.rejects(
    createFirstAdmin(payload, { email: 'CLI@example.com', password }),
    /database is locked/,
  )
  assert.equal(userRows(sqlite).length, 0)
  assert.equal(deletes.length, 1)
  assert.equal(claimToken(sqlite), null)
  // A plain retry succeeds.
  const { payload: retry } = fakePayload(sqlite, db)
  await createFirstAdmin(retry, { email: 'cli@example.com', password })
  assert.deepEqual(
    userRows(sqlite).map((user) => [user.email, JSON.parse(user.roles)]),
    [['cli@example.com', [SUPER_ADMIN_ID]]],
  )
})

test('a setup whose cleanup failed keeps its claim, so the next CLI run finishes it', async () => {
  const { db, sqlite } = sqliteDatabase()
  await completedThenEmptied(sqlite, db)
  const failing = fakePayload(sqlite, db, { failRoleUpdate: true, failDelete: true })
  await assert.rejects(createFirstAdmin(failing.payload, { email: 'cli@example.com', password }))
  assert.equal(userRows(sqlite).length, 1)
  assert.notEqual(claimToken(sqlite), null)

  const { payload } = fakePayload(sqlite, db)
  // The claim is still live: the failed attempt is not recovered underneath it.
  await assert.rejects(
    createFirstAdmin(payload, { email: 'retry@example.com', password }),
    (error: { status?: number }) => error.status === 409,
  )
  expireClaims(sqlite)
  // The web flow stays closed after completion, even over an interrupted CLI setup.
  await assert.rejects(
    createFirstAdminAccount(
      payload,
      { email: 'web@example.com', password },
      { source: 'web', req: webReq() },
    ),
    (error: { status?: number }) => error.status === 403,
  )
  assert.deepEqual(JSON.parse(userRows(sqlite)[0].roles), [])
  const recovered = await createFirstAdmin(payload, { email: 'retry@example.com', password })
  const users = userRows(sqlite)
  assert.deepEqual(
    users.map((user) => [user.id, user.email, JSON.parse(user.roles)]),
    [[recovered.id, 'cli@example.com', [SUPER_ADMIN_ID]]],
  )
  assert.equal(claimToken(sqlite), null)
})

test('the next web attempt finishes an interrupted setup without a second admin', async () => {
  const { db, sqlite } = sqliteDatabase()
  await interruptedSetup(sqlite, db, 'one@example.com')
  expireClaims(sqlite)
  const { payload, logs } = fakePayload(sqlite, db)
  // The retry submits different credentials: recovery must keep the existing account as is.
  const recovered = await createFirstAdminAccount(
    payload,
    { email: 'retry@example.com', password },
    { source: 'web', req: webReq() },
  )
  const users = userRows(sqlite)
  assert.equal(users.length, 1)
  assert.deepEqual([recovered.id, recovered.email], [users[0].id, 'one@example.com'])
  assert.deepEqual(JSON.parse(users[0].roles), [SUPER_ADMIN_ID])
  assert.equal(await createSetupState(db).completed(), true)
  assert.match(JSON.stringify(logs), /First-run setup recovered/)
  // Setup is closed afterwards, like any completed setup.
  await assert.rejects(
    createFirstAdminAccount(
      payload,
      { email: 'three@example.com', password },
      { source: 'web', req: webReq() },
    ),
    (error: { status?: number }) => error.status === 403,
  )
})

test('the CLI finishes an interrupted setup too', async () => {
  const { db, sqlite } = sqliteDatabase()
  await interruptedSetup(sqlite, db, 'one@example.com')
  expireClaims(sqlite)
  const { payload } = fakePayload(sqlite, db)
  const recovered = await createFirstAdmin(payload, { email: 'retry@example.com', password })
  const users = userRows(sqlite)
  assert.equal(users.length, 1)
  assert.deepEqual([recovered.id, recovered.email], [users[0].id, 'one@example.com'])
  assert.deepEqual(JSON.parse(users[0].roles), [SUPER_ADMIN_ID])
  assert.equal(await createSetupState(db).completed(), true)
})

test('recovery never runs under a live claim or with more than one user', async () => {
  // Live claim: the attempt may still be running, so its user is not promoted or sealed
  // in as recovered; the request is refused and the roles stay untouched.
  const live = sqliteDatabase()
  await interruptedSetup(live.sqlite, live.db, 'one@example.com')
  const livePayload = fakePayload(live.sqlite, live.db)
  await assert.rejects(
    createFirstAdminAccount(
      livePayload.payload,
      { email: 'retry@example.com', password },
      { source: 'web', req: webReq() },
    ),
    (error: { status?: number }) => error.status === 403,
  )
  assert.deepEqual(JSON.parse(userRows(live.sqlite)[0].roles), [])
  assert.equal(await createSetupState(live.db).interruptedUserId(), null)

  // Two users: not the state an interrupted first setup leaves, so nothing is promoted.
  const two = sqliteDatabase()
  await interruptedSetup(two.sqlite, two.db, 'one@example.com')
  two.sqlite.prepare("INSERT INTO users (email, roles) VALUES ('two@example.com', '[]')").run()
  expireClaims(two.sqlite)
  const twoPayload = fakePayload(two.sqlite, two.db)
  await assert.rejects(
    createFirstAdminAccount(
      twoPayload.payload,
      { email: 'retry@example.com', password },
      { source: 'web', req: webReq() },
    ),
    (error: { status?: number }) => error.status === 403,
  )
  assert.deepEqual(
    userRows(two.sqlite).map((user) => JSON.parse(user.roles)),
    [[], []],
  )
  assert.equal(await createSetupState(two.db).interruptedUserId(), null)
})

test('completion requires exactly one user', async () => {
  const { db, sqlite } = sqliteDatabase()
  const state = createSetupState(db)
  assert.equal(await state.claim('a'), true)
  assert.equal(await state.complete('a'), false)
  sqlite.prepare("INSERT INTO users (email) VALUES ('one@example.com')").run()
  sqlite.prepare("INSERT INTO users (email) VALUES ('two@example.com')").run()
  assert.equal(await state.complete('a'), false)
  sqlite.prepare("DELETE FROM users WHERE email = 'two@example.com'").run()
  assert.equal(await state.complete('a'), true)
})
