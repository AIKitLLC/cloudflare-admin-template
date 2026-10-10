import { randomUUID } from 'node:crypto'

import { getPayload, type Payload, type PayloadRequest } from 'payload'
import config from '@/payload.config'
import { beforeAll, describe, expect, it } from 'vitest'

import { DELETE as restDelete, PATCH as restPatch } from '@/app/(payload)/api/[...slug]/route'
import { POST as graphqlPost } from '@/app/(payload)/api/graphql/route'
import { AUDIT_LOG_READER_EMAILS_ENV } from '@/audit/constants'
import { droppedAuditWriteCount } from '@/audit/logging/droppedAuditWrites'

let payload: Payload

const subjects = 'audit-subjects' as 'users'

describe('audit operations', () => {
  beforeAll(async () => {
    payload = await getPayload({ config: await config })
  })

  it('pairs bulk updates and bulk deletes with the document that changed', async () => {
    const alpha = await createSubject({ title: 'alpha', note: 'note-alpha' })
    const beta = await createSubject({ title: 'beta', note: 'note-beta' })
    const before = await latestAuditId()

    await payload.update({
      collection: subjects,
      data: { title: 'bulk-title' } as never,
      overrideAccess: true,
      where: { id: { in: [alpha.id, beta.id] } },
    })

    const updates = (await findLogs(before)).filter((log) => log.action === 'UPDATE')
    expect(changeByPath(updates.find((log) => log.documentId === String(alpha.id)), 'title')).toMatchObject({
      oldValue: 'alpha',
      newValue: 'bulk-title',
    })
    expect(changeByPath(updates.find((log) => log.documentId === String(beta.id)), 'title')).toMatchObject({
      oldValue: 'beta',
      newValue: 'bulk-title',
    })

    await payload.delete({
      collection: subjects,
      overrideAccess: true,
      where: { id: { in: [alpha.id, beta.id] } },
    })

    const deletes = (await findLogs(before)).filter((log) => log.action === 'DELETE')
    expect(changeByPath(deletes.find((log) => log.documentId === String(alpha.id)), 'note')?.oldValue).toBe(
      'note-alpha',
    )
    expect(changeByPath(deletes.find((log) => log.documentId === String(beta.id)), 'note')?.oldValue).toBe(
      'note-beta',
    )
  })

  it('does not apply a failed write snapshot to the next write in the same request', async () => {
    const first = await createSubject({ title: 'kept', note: 'first-note' })
    const second = await createSubject({ title: 'other', note: 'second-note' })
    const req = { context: {}, headers: new Headers() } as PayloadRequest
    const before = await latestAuditId()

    await expect(
      payload.update({
        collection: subjects,
        id: first.id,
        data: { title: 'should-not-apply', failNext: true } as never,
        overrideAccess: true,
        req,
      }),
    ).rejects.toThrow(/intentional audit subject failure/)

    await payload.update({
      collection: subjects,
      id: second.id,
      data: { title: 'second-write' } as never,
      overrideAccess: true,
      req,
    })

    const updates = (await findLogs(before)).filter(
      (log) => log.action === 'UPDATE' && log.documentId === String(second.id),
    )
    expect(updates).toHaveLength(1)
    expect(changeByPath(updates[0], 'title')).toMatchObject({
      oldValue: 'other',
      newValue: 'second-write',
    })
    expect(JSON.stringify(updates)).not.toContain('should-not-apply')
    expect(JSON.stringify(updates)).not.toContain('first-note')
  })

  it('deletes through the HTTP route and writes one delete log', async () => {
    const password = `pw-${randomUUID()}`
    const email = `http-delete-${randomUUID()}@example.com`
    const user = await payload.create({
      collection: 'users',
      data: { email, password },
      overrideAccess: true,
    })
    const subject = await createSubject({ title: 'http-delete', note: 'gone-by-http' })
    const login = await payload.login({ collection: 'users', data: { email, password } })
    const before = await latestAuditId()

    const response = await restDelete(
      new Request(`http://localhost/api/audit-subjects/${subject.id}`, {
        method: 'DELETE',
        headers: { Authorization: `JWT ${login.token}` },
      }),
      { params: Promise.resolve({ slug: ['audit-subjects', String(subject.id)] }) },
    )
    expect(response.status).toBe(200)

    const deletes = (await findLogs(before)).filter(
      (log) => log.action === 'DELETE' && log.documentId === String(subject.id),
    )
    expect(deletes).toHaveLength(1)
    expect(changeByPath(deletes[0], 'note')?.oldValue).toBe('gone-by-http')
    expect(user.id).toBeDefined()
  })

  it('refuses REST and GraphQL updates and deletes of audit logs', async () => {
    const password = `pw-${randomUUID()}`
    const email = `audit-deny-${randomUUID()}@example.com`
    await payload.create({
      collection: 'users',
      data: { email, password },
      overrideAccess: true,
    })
    const login = await payload.login({ collection: 'users', data: { email, password } })
    const subject = await createSubject({ title: 'locked-log' })
    const before = await latestAuditId()
    await payload.update({
      collection: subjects,
      id: subject.id,
      data: { title: 'locked-log-2' } as never,
      overrideAccess: true,
    })
    const log = (await findLogs(before)).find((entry) => entry.action === 'UPDATE')
    expect(log?.id).toBeDefined()

    const patch = await restPatch(
      new Request(`http://localhost/api/audit-logs/${log!.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `JWT ${login.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ summary: 'tampered' }),
      }),
      { params: Promise.resolve({ slug: ['audit-logs', String(log!.id)] }) },
    )
    expect(patch.status).toBe(403)

    const deleted = await restDelete(
      new Request(`http://localhost/api/audit-logs/${log!.id}`, {
        method: 'DELETE',
        headers: { Authorization: `JWT ${login.token}` },
      }),
      { params: Promise.resolve({ slug: ['audit-logs', String(log!.id)] }) },
    )
    expect(deleted.status).toBe(403)

    const names = await graphqlMutationNames(login.token ?? '')
    const updateName = names.find((name) => /update/i.test(name) && /auditlog/i.test(name))
    const deleteName = names.find((name) => /delete/i.test(name) && /auditlog/i.test(name))
    expect(updateName).toBeTruthy()
    expect(deleteName).toBeTruthy()

    const updated = await graphql(login.token ?? '', `mutation($id: Int!) { ${updateName}(id: $id, data: { summary: "tampered" }) { id } }`, {
      id: log!.id,
    })
    expect(JSON.stringify(updated.body)).toMatch(/forbid|not allowed|unauthorized|error/i)

    const removed = await graphql(login.token ?? '', `mutation($id: Int!) { ${deleteName}(id: $id) { id } }`, {
      id: log!.id,
    })
    expect(JSON.stringify(removed.body)).toMatch(/forbid|not allowed|unauthorized|error/i)

    const stillThere = await payload.findByID({
      collection: 'audit-logs',
      id: log!.id,
      overrideAccess: true,
    })
    expect(stillThere.summary).not.toBe('tampered')
  })

  it('does not log a phantom relationship diff when depth populates the after document', async () => {
    const password = `pw-${randomUUID()}`
    const email = `rel-${randomUUID()}@example.com`
    const owner = await payload.create({
      collection: 'users',
      data: { email, password },
      overrideAccess: true,
    })
    const before = await latestAuditId()
    const subject = await payload.create({
      collection: subjects,
      data: {
        title: 'related',
        owner: owner.id,
        watchers: [owner.id],
        pointer: { relationTo: 'users', value: owner.id },
      } as never,
      depth: 2,
      overrideAccess: true,
    })
    await payload.update({
      collection: subjects,
      id: subject.id,
      data: { title: 'related-renamed' } as never,
      depth: 2,
      overrideAccess: true,
    })

    const update = (await findLogs(before)).find(
      (log) => log.action === 'UPDATE' && log.documentId === String(subject.id),
    )
    const paths = (update?.changes ?? []).map((change) => change.path)
    expect(paths).toContain('title')
    expect(paths).not.toContain('owner')
    expect(paths).not.toContain('watchers')
    expect(paths).not.toContain('pointer')
    expect(JSON.stringify(update?.changes ?? [])).not.toContain(email)

    const created = (await findLogs(before)).find(
      (log) => log.action === 'CREATE' && log.documentId === String(subject.id),
    )
    expect(changeByPath(created, 'owner')?.newValue).toBe(owner.id)
    expect(changeByPath(created, 'pointer.relationTo')?.newValue).toBe('users')
    expect(changeByPath(created, 'pointer.value')?.newValue).toBe(owner.id)
    expect(JSON.stringify(created?.changes ?? [])).not.toContain(email)
  })

  it('records more than 16 field changes without dropping rows', async () => {
    const initial: Record<string, unknown> = { title: 'wide' }
    const next: Record<string, unknown> = { title: 'wide-next' }
    for (let index = 1; index <= 20; index += 1) {
      const name = `field${String(index).padStart(2, '0')}`
      initial[name] = `before-${index}`
      next[name] = `after-${index}`
    }
    const subject = await createSubject(initial)
    const before = await latestAuditId()
    await payload.update({
      collection: subjects,
      id: subject.id,
      data: next as never,
      overrideAccess: true,
    })

    const update = (await findLogs(before)).find(
      (log) => log.action === 'UPDATE' && log.documentId === String(subject.id),
    )
    const paths = new Set((update?.changes ?? []).map((change) => change.path))
    expect(paths.has('title')).toBe(true)
    expect(paths.has('field01')).toBe(true)
    expect(paths.has('field16')).toBe(true)
    expect(paths.has('field20')).toBe(true)
    expect(changeByPath(update, 'field20')).toMatchObject({
      oldValue: 'before-20',
      newValue: 'after-20',
    })
  })

  it('removes a partial audit log when a later change batch fails', async () => {
    const initial: Record<string, unknown> = { title: 'partial' }
    const next: Record<string, unknown> = { title: 'partial-next' }
    for (let index = 1; index <= 20; index += 1) {
      const name = `field${String(index).padStart(2, '0')}`
      initial[name] = `before-${index}`
      next[name] = `after-${index}`
    }
    const subject = await createSubject(initial)
    const before = await latestAuditId()
    const droppedBefore = droppedAuditWriteCount()
    const originalUpdate = payload.update.bind(payload)
    payload.update = (async (args: Parameters<Payload['update']>[0]) => {
      if (args.collection === 'audit-logs') throw new Error('later batch failed')
      return originalUpdate(args)
    }) as Payload['update']

    try {
      await payload.update({
        collection: subjects,
        id: subject.id,
        data: next as never,
        overrideAccess: true,
      })
    } finally {
      payload.update = originalUpdate
    }

    const saved = await payload.findByID({
      collection: subjects,
      id: subject.id,
      depth: 0,
      overrideAccess: true,
    })
    expect((saved as { title?: string }).title).toBe('partial-next')
    const updates = (await findLogs(before)).filter(
      (log) => log.action === 'UPDATE' && log.documentId === String(subject.id),
    )
    expect(updates).toHaveLength(0)
    expect(droppedAuditWriteCount()).toBe(droppedBefore + 1)
  })

  it('denies audit log reads for users who are not the earliest user or on the allowlist', async () => {
    const password = `pw-${randomUUID()}`
    const email = `denied-${randomUUID()}@example.com`
    const previousAllowlist = process.env[AUDIT_LOG_READER_EMAILS_ENV]
    delete process.env[AUDIT_LOG_READER_EMAILS_ENV]
    try {
      const denied = await payload.create({
        collection: 'users',
        data: { email, password },
        overrideAccess: true,
      })

      await expect(
        payload.find({ collection: 'audit-logs', overrideAccess: false, user: denied }),
      ).rejects.toThrow()

      process.env[AUDIT_LOG_READER_EMAILS_ENV] = email
      const allowed = await payload.find({
        collection: 'audit-logs',
        overrideAccess: false,
        user: denied,
        limit: 1,
      })
      expect(allowed.docs).toBeDefined()
    } finally {
      if (previousAllowlist === undefined) delete process.env[AUDIT_LOG_READER_EMAILS_ENV]
      else process.env[AUDIT_LOG_READER_EMAILS_ENV] = previousAllowlist
    }

    const earliest = await payload.find({
      collection: 'users',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      sort: 'id',
    })
    const asEarliest = await payload.find({
      collection: 'audit-logs',
      overrideAccess: false,
      user: earliest.docs[0],
      limit: 1,
    })
    expect(asEarliest.docs).toBeDefined()
  })
})

async function createSubject(data: Record<string, unknown>) {
  return payload.create({
    collection: subjects,
    data: data as never,
    depth: 0,
    overrideAccess: true,
  })
}

async function latestAuditId(): Promise<number> {
  const result = await payload.find({
    collection: 'audit-logs',
    limit: 1,
    overrideAccess: true,
    sort: '-id',
  })
  return result.docs[0]?.id ?? 0
}

async function findLogs(afterId: number) {
  const result = await payload.find({
    collection: 'audit-logs',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    sort: 'id',
    where: { id: { greater_than: afterId } },
  })
  return result.docs
}

function changeByPath(
  log: { changes?: { path: string; oldValue?: unknown; newValue?: unknown }[] | null } | undefined,
  path: string,
) {
  return log?.changes?.find((change) => change.path === path)
}

async function graphql(token: string, query: string, variables?: Record<string, unknown>) {
  const response = await graphqlPost(
    new Request('http://localhost/api/graphql', {
      method: 'POST',
      headers: {
        Authorization: `JWT ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    }),
  )
  const body = (await response.json()) as unknown
  return { status: response.status, body }
}

async function graphqlMutationNames(token: string): Promise<string[]> {
  const result = await graphql(
    token,
    '{ __schema { mutationType { fields { name } } } }',
  )
  const body = result.body as {
    data?: { __schema?: { mutationType?: { fields?: { name: string }[] } } }
  }
  return body.data?.__schema?.mutationType?.fields?.map((field) => field.name) ?? []
}
