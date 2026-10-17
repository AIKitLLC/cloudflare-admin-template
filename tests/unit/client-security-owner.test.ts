import assert from 'node:assert/strict'
import test from 'node:test'
import { SignJWT } from 'jose'
import {
  createOperation,
  forgotPasswordOperation,
  resetPasswordOperation,
  JWTAuthentication,
  updateByIDOperation,
  type Payload,
  type PayloadRequest,
  type Where,
  type CollectionConfig,
} from 'payload'

import { Users } from '../../src/collections/Users'
import {
  guardClientSecurityOwnerChange,
  guardClientSecurityOwnerDelete,
  guardClientSecurityOwnerOperation,
  isClientSecurityOwner,
  isStoredClientSecurityOwner,
  clearClientSecurityRecoveryOperation,
} from '../../src/auth/client-security-owner'
import {
  bootstrapClientSecurityOwner,
  parseBootstrapArguments,
} from '../../scripts/bootstrap-client-security-owner.mjs'

type FakeUser = {
  id: number
  role?: string
  email: string
  sessions: { id: string }[]
  [key: string]: unknown
}
const admin = (id = 1, role = 'admin'): FakeUser => ({
  id,
  role,
  email: `${id}@fixture.invalid`,
  sessions: [{ id: 'fixture-session' }],
})
function matches(user: FakeUser, where?: Where): boolean {
  if (!where) return true
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'and') return (condition as Where[]).every((part) => matches(user, part))
    if (field === 'or') return (condition as Where[]).some((part) => matches(user, part))
    const value = user[field as keyof FakeUser]
    const query = condition as { equals?: unknown; in?: unknown[]; greater_than?: unknown }
    if (query.greater_than !== undefined) return String(value) > String(query.greater_than)
    return query.in ? query.in.includes(value) : value === query.equals
  })
}

function fixture(
  records: FakeUser[] = [admin(), admin(2, 'owner')],
  actor: unknown = { id: 1, collection: 'users', role: 'owner' },
) {
  const users = new Map(records.map((user) => [user.id, { ...user }]))
  let writes = 0
  const collection = {
    config: {
      ...Users,
      auth: { depth: 0, useSessions: true, tokenExpiration: 3600 },
      flattenedFields: [] as CollectionConfig['fields'],
    },
  }
  const payload = {
    secret: 'synthetic-owner-test-secret',
    config: {
      admin: {},
      auth: { jwtOrder: ['Bearer', 'JWT', 'cookie'] },
      csrf: [],
      cookiePrefix: 'payload',
    },
    collections: { users: collection },
    db: {
      binding: {
        prepare: (sql: string) => ({
          bind: (id: number) => ({
            run: async () => {
              assert.match(
                sql,
                /WHERE id = \? AND NOT EXISTS \(SELECT 1 FROM users WHERE role = 'owner'\)/,
              )
              const user = users.get(id)
              if (!user || [...users.values()].some((candidate) => candidate.role === 'owner'))
                return { success: true, meta: { changes: 0 } }
              user.role = 'owner'
              writes++
              return { success: true, meta: { changes: 1 } }
            },
          }),
        }),
      },
    },
    findByID: async ({ id }: { id: number | string }) => {
      const user = users.get(Number(id))
      if (!user) throw new Error('Not found')
      return { ...user }
    },
    count: async ({ where }: { where?: Where }) => ({
      totalDocs: [...users.values()].filter((user) => matches(user, where)).length,
    }),
  } as unknown as Payload
  const req = {
    payload,
    user: actor,
    context: {},
    payloadAPI: 'local',
    t: (key: string) => key,
  } as unknown as PayloadRequest
  return { payload, req, users, collection, writes: () => writes }
}

async function operation(
  f: ReturnType<typeof fixture>,
  kind: 'create' | 'update' | 'delete',
  args: Record<string, unknown>,
) {
  await guardClientSecurityOwnerOperation({
    operation: kind,
    args,
    req: f.req,
    collection: f.collection.config,
    context: f.req.context,
  } as Parameters<typeof guardClientSecurityOwnerOperation>[0])
}
const status = (expected: number) => (error: unknown) =>
  !!error && (error as { status?: number }).status === expected

test('Users adds explicit owner/admin/editor with admin default while preserving existing CMS access', () => {
  assert.equal(Users.auth, true)
  assert.equal(Users.access, undefined)
  const role = Users.fields.find((field) => 'name' in field && field.name === 'role')
  assert.equal(role?.type, 'select')
  assert.equal(role && 'defaultValue' in role ? role.defaultValue : undefined, 'admin')
  assert.equal(role && 'required' in role ? role.required : undefined, true)
  assert.deepEqual(
    role && 'options' in role
      ? role.options.map((option) => (typeof option === 'string' ? option : option.value))
      : [],
    ['owner', 'admin', 'editor'],
  )
})

test('owner identity requires Users collection and fresh stored authority, not Firebase or request role', async () => {
  const f = fixture()
  assert.equal(isClientSecurityOwner({ id: 2, role: 'owner' }), false)
  assert.equal(
    isClientSecurityOwner({ uid: 'firebase-id', projectId: 'fixture', role: 'owner' }),
    false,
  )
  assert.equal(isClientSecurityOwner({ id: 2, collection: 'media', role: 'owner' }), false)
  assert.equal(isClientSecurityOwner({ id: 2, collection: 'users', role: 'owner' }), true)
  assert.equal(await isStoredClientSecurityOwner(f.payload, f.req.user), false)
  assert.equal(
    await isStoredClientSecurityOwner(f.payload, { id: 2, collection: 'users', role: 'admin' }),
    true,
  )
  assert.equal(
    await isStoredClientSecurityOwner(f.payload, { id: 99, collection: 'users', role: 'owner' }),
    false,
  )
})

test('actual Payload JWT strategy reloads a stored admin despite forged owner JWT claims', async () => {
  const f = fixture()
  const token = await new SignJWT({
    collection: 'users',
    id: 1,
    sid: 'fixture-session',
    role: 'owner',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(f.payload.secret))
  const result = await JWTAuthentication({
    payload: f.payload,
    headers: new Headers({ Authorization: `Bearer ${token}` }),
  })
  assert.equal((result.user as unknown as FakeUser).role, 'admin')
  assert.equal(result.user?.collection, 'users')
  assert.equal(await isStoredClientSecurityOwner(f.payload, result.user), false)
})

for (const actor of [
  null,
  { id: 1, collection: 'users', role: 'admin' },
  { id: 3, collection: 'users', role: 'editor' },
  { uid: 'firebase-account', role: 'owner' },
]) {
  test(`raw role assignment is denied with Local API override for ${actor ? JSON.stringify(actor) : 'no actor'}`, async () => {
    const f = fixture([admin(), admin(2, 'owner'), admin(3, 'editor')], actor)
    await assert.rejects(
      operation(f, 'create', {
        data: { email: 'new@fixture.invalid', role: 'owner' },
        overrideAccess: true,
      }),
      status(403),
    )
    await assert.rejects(
      operation(f, 'update', { id: 1, data: { role: 'owner' }, overrideAccess: true }),
      status(403),
    )
  })
}

test('actual Payload create/update operations reject raw role attempts before field stripping with overrideAccess true', async () => {
  const f = fixture()
  for (const invoke of [createOperation, updateByIDOperation]) {
    const args = {
      id: 1,
      collection: f.collection,
      req: f.req,
      data: { email: 'attempt@fixture.invalid', role: 'owner' },
      overrideAccess: true,
      disableTransaction: true,
    }
    await assert.rejects(invoke(args as never), status(403))
  }
})

test('body context, HTTP context, and client claims cannot enable initial owner bootstrap', async () => {
  const f = fixture([admin()], null)
  const data = { role: 'owner', context: { clientSecurityOwnerBootstrap: true } }
  await assert.rejects(operation(f, 'update', { id: 1, data }), status(403))
  f.req.context.clientSecurityOwnerBootstrap = true
  f.req.payloadAPI = 'REST'
  await assert.rejects(operation(f, 'update', { id: 1, data: { role: 'owner' } }), status(403))
})

test('Local API context flags cannot replace the atomic operator bootstrap', async () => {
  const f = fixture([admin()], null)
  f.req.context.clientSecurityOwnerBootstrap = true
  await assert.rejects(operation(f, 'update', { id: 1, data: { role: 'owner' } }), status(403))
  await assert.rejects(
    operation(f, 'update', { where: { id: { equals: 1 } }, data: { role: 'owner' } }),
    status(403),
  )
  f.users.get(1)!.role = 'owner'
  await assert.rejects(operation(f, 'update', { id: 1, data: { role: 'owner' } }), status(403))
})

test('owner can manage roles; nonowners retain ordinary user updates but cannot modify owner credentials', async () => {
  const f = fixture([admin(), admin(2, 'owner'), admin(3, 'owner')], { id: 2, collection: 'users' })
  await operation(f, 'update', { id: 1, data: { role: 'editor' } })
  await operation(f, 'update', { id: 2, data: { role: 'admin' } })
  f.req.user = { id: 1, collection: 'users' } as PayloadRequest['user']
  await operation(f, 'update', { id: 1, data: { email: 'new@fixture.invalid' } })
  await assert.rejects(
    operation(f, 'update', { id: 2, data: { password: 'forged-password' } }),
    status(403),
  )
  await assert.rejects(operation(f, 'delete', { id: 2 }), status(403))
})

test('ordinary exact-ID profile edits accept the unchanged stored role emitted by Payload forms', async () => {
  const f = fixture([admin(), admin(2, 'owner'), admin(3, 'editor')], {
    id: 1,
    collection: 'users',
  })
  await operation(f, 'update', { id: 1, data: { role: 'admin', email: 'edited@fixture.invalid' } })
  await operation(f, 'update', {
    id: 3,
    data: { role: 'editor', email: 'editor-edited@fixture.invalid' },
  })
  await assert.rejects(
    operation(f, 'update', { id: 1, data: { role: 'editor', email: 'changed@fixture.invalid' } }),
    status(403),
  )
  await assert.rejects(operation(f, 'update', { id: 3, data: { role: 'admin' } }), status(403))
  await assert.rejects(
    operation(f, 'update', { id: 2, data: { role: 'owner', email: 'takeover@fixture.invalid' } }),
    status(403),
  )
  await assert.rejects(
    operation(f, 'update', { where: { role: { equals: 'admin' } }, data: { role: 'admin' } }),
    status(403),
  )
  f.users.get(1)!.role = 'editor'
  await assert.rejects(operation(f, 'update', { id: 1, data: { role: 'admin' } }), status(403))
})

test('last owner demotion/deletion and bulk removal of all owners fail409', async () => {
  const f = fixture([admin(1, 'owner')], { id: 1, collection: 'users' })
  await assert.rejects(operation(f, 'update', { id: 1, data: { role: 'admin' } }), status(409))
  await assert.rejects(operation(f, 'delete', { id: 1 }), status(409))
  f.users.set(2, admin(2, 'owner'))
  await assert.rejects(
    operation(f, 'update', { where: { role: { equals: 'owner' } }, data: { role: 'editor' } }),
    status(409),
  )
  await assert.rejects(
    operation(f, 'delete', { where: { role: { equals: 'owner' } } }),
    status(409),
  )
  await operation(f, 'delete', { id: 2 })
})

test('document hooks recheck owner mutation/deletion while default admin creation stays unchanged', async () => {
  const f = fixture([admin(1, 'owner')], { id: 1, collection: 'users' })
  const change = (data: Record<string, unknown>) =>
    guardClientSecurityOwnerChange({
      data,
      operation: 'update',
      originalDoc: admin(1, 'owner'),
      req: f.req,
    } as Parameters<typeof guardClientSecurityOwnerChange>[0])
  await assert.rejects(change({ role: 'admin' }), status(409))
  await assert.rejects(
    guardClientSecurityOwnerDelete({ id: 1, req: f.req } as Parameters<
      typeof guardClientSecurityOwnerDelete
    >[0]),
    status(409),
  )
  f.req.user = null
  await assert.rejects(change({ email: 'takeover@fixture.invalid' }), status(403))
  await operation(f, 'create', { data: { email: 'new@fixture.invalid' } })
  await operation(f, 'create', { data: { email: 'new@fixture.invalid', role: 'admin' } })
  await assert.rejects(
    operation(f, 'create', { data: { email: 'new@fixture.invalid', role: 'editor' } }),
    status(403),
  )
})

test('role field permissions make it read-only for ordinary admin profiles and editable for owners', async () => {
  const f = fixture()
  const field = Users.fields.find((candidate) => 'name' in candidate && candidate.name === 'role')!
  assert.ok('access' in field && field.access?.update)
  const access = field.access.update
  assert.equal(await access({ req: f.req } as Parameters<typeof access>[0]), false)
  f.req.user = { id: 2, collection: 'users' } as PayloadRequest['user']
  assert.equal(await access({ req: f.req } as Parameters<typeof access>[0]), true)
})

test('actual Payload forgot/reset password preserves owner recovery without permitting direct reset-token writes', async () => {
  const f = fixture([admin(1, 'owner')], null)
  await assert.rejects(
    operation(f, 'update', {
      id: 1,
      data: {
        resetPasswordToken: 'a'.repeat(40),
        resetPasswordExpiration: new Date(Date.now() + 3600000).toISOString(),
      },
    }),
    status(403),
  )
  const db = f.payload.db as unknown as {
    findOne: (args: { where: Where }) => Promise<FakeUser | undefined>
    updateOne: (args: { id: number; data: Record<string, unknown> }) => Promise<FakeUser>
  }
  db.findOne = async ({ where }) => {
    const user = [...f.users.values()].find((record) => matches(record, where))
    return user ? { ...user } : undefined
  }
  db.updateOne = async ({ id, data }) => {
    const user = { ...f.users.get(id)!, ...data }
    f.users.set(id, user)
    return { ...user }
  }
  f.payload.update = (async ({
    id,
    data,
    req,
  }: {
    id: number
    data: Record<string, unknown>
    req: PayloadRequest
  }) => {
    assert.equal(req, f.req)
    await operation(f, 'update', { id, data })
    await guardClientSecurityOwnerChange({
      collection: f.collection.config,
      context: req.context,
      operation: 'update',
      originalDoc: f.users.get(id),
      data: { ...data, role: 'owner' },
      req,
    } as unknown as Parameters<typeof guardClientSecurityOwnerChange>[0])
    const user = await db.updateOne({ id, data })
    clearClientSecurityRecoveryOperation({
      operation: 'updateByID',
      req,
      result: user,
    } as unknown as Parameters<typeof clearClientSecurityRecoveryOperation>[0])
    return user
  }) as unknown as Payload['update']
  const token = await forgotPasswordOperation({
    collection: f.collection,
    data: { email: '1@fixture.invalid' },
    disableEmail: true,
    req: f.req,
  } as Parameters<typeof forgotPasswordOperation>[0])
  assert.equal(typeof token, 'string')
  assert.equal(token?.length, 40)
  assert.equal(f.users.get(1)?.role, 'owner')
  const result = await resetPasswordOperation({
    collection: f.collection,
    data: { token: token!, password: 'new-synthetic-password' },
    overrideAccess: true,
    req: f.req,
  } as Parameters<typeof resetPasswordOperation>[0])
  assert.equal(result.user.role, 'owner')
  assert.equal(typeof result.token, 'string')
  assert.equal(typeof f.users.get(1)?.hash, 'string')
  f.req.user = null
  await assert.rejects(
    operation(f, 'update', {
      id: 1,
      data: {
        resetPasswordToken: 'b'.repeat(40),
        resetPasswordExpiration: new Date(Date.now() + 3600000).toISOString(),
      },
    }),
    status(403),
  )
})

test('operator bootstrap requires exact positive user ID and explicit confirmation', () => {
  assert.equal(parseBootstrapArguments(['--user-id', '7', '--confirm']), 7)
  for (const args of [
    [],
    ['--user-id', '7'],
    ['--confirm'],
    ['--user-id', '0', '--confirm'],
    ['--user-id', '1e2', '--confirm'],
    ['--user-id', '7', '--confirm', '--all'],
  ])
    assert.throws(() => parseBootstrapArguments(args))
})

test('operator bootstrap uses guarded atomic SQL and concurrent claims cannot both assign owners', async () => {
  const f = fixture([admin(), admin(2)], null)
  const results = await Promise.allSettled([
    bootstrapClientSecurityOwner(f.payload, 1),
    bootstrapClientSecurityOwner(f.payload, 2),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(
    results.filter((result) => result.status === 'rejected' && status(409)(result.reason)).length,
    1,
  )
  assert.equal(f.writes(), 1)
  assert.equal([...f.users.values()].filter((user) => user.role === 'owner').length, 1)
})
