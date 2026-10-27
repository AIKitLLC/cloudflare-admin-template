import type { PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { CHANGE_ROW_INSERT_CHUNK, MAX_CHANGE_ROWS, REDACTED_VALUE } from '@/audit/constants'
import {
  applyAuditLogViewerFilters,
  readAuditLogViewerFilters,
  toAuditLogWhere,
} from '@/audit/admin/auditLogViewerQuery'
import { buildChangeSummary } from '@/audit/diff/buildChangeSummary'
import { capFieldChanges } from '@/audit/diff/capFieldChanges'
import { computeFieldDiff } from '@/audit/diff/computeFieldDiff'
import { projectBeforeOntoAfter } from '@/audit/diff/projectBeforeOntoAfter'
import { SensitiveFieldPolicy } from '@/audit/diff/SensitiveFieldPolicy'
import { FailOpenAuditLogWriter } from '@/audit/logging/FailOpenAuditLogWriter'
import { PayloadAuditLogWriter } from '@/audit/logging/PayloadAuditLogWriter'
import { runAuditChange } from '@/audit/logging/runAuditRecord'
import type { RequestAuditMetadata } from '@/audit/types'
import { normalizeRelations } from '@/audit/diff/normalizeRelations'
import { droppedAuditWriteCount } from '@/audit/logging/droppedAuditWrites'
import {
  rememberAuditCapture,
  takeAuditCapture,
} from '@/audit/request/AuditContextStore'
import {
  readRequestMetadata,
  readTrustedClientIp,
  readUntrustedClientIp,
} from '@/audit/request/readRequestMetadata'
import type { AuditLogEntry } from '@/audit/types'

const policy = SensitiveFieldPolicy.fromExtraFields(['pin'])

describe('field diff', () => {
  it('records old and new values for an update and skips timestamps', () => {
    const changes = computeFieldDiff(
      { id: 1, email: 'a@example.com', updatedAt: 't1', createdAt: 't0' },
      { id: 1, email: 'b@example.com', updatedAt: 't2', createdAt: 't0' },
      policy,
    )

    expect(changes).toEqual([
      { path: 'email', oldValue: 'a@example.com', newValue: 'b@example.com' },
    ])
  })

  it('treats a missing before document as a create', () => {
    const changes = computeFieldDiff(null, { alt: 'Banner', filename: null }, policy)
    expect(changes).toEqual([{ path: 'alt', oldValue: null, newValue: 'Banner' }])
  })

  it('records every populated field when a document is deleted', () => {
    const changes = computeFieldDiff({ alt: 'Banner', filename: null }, null, policy)
    expect(changes).toEqual([{ path: 'alt', oldValue: 'Banner', newValue: null }])
  })

  it('walks nested groups and redacts secrets inside a replaced object', () => {
    const secret = 'nested-token-value'
    const changes = computeFieldDiff(
      { profile: { name: 'Ada', token: secret } },
      { profile: 'cleared' },
      policy,
    )

    const serialized = JSON.stringify(changes)
    expect(serialized).not.toContain(secret)
    expect(changes[0]?.path).toBe('profile')
    expect(serialized).toContain(REDACTED_VALUE)
  })

  it('redacts password, hash, and collection-specific fields without copying them', () => {
    const password = 'plain-text-password'
    const hash = 'stored-hash-value'
    const changes = computeFieldDiff(
      { email: 'a@example.com', hash, pin: '1234' },
      { email: 'a@example.com', hash: 'next-hash', pin: '9999', password },
      policy,
    )

    const serialized = JSON.stringify(changes)
    expect(serialized).not.toContain(password)
    expect(serialized).not.toContain(hash)
    expect(serialized).not.toContain('next-hash')
    expect(serialized).not.toContain('1234')
    expect(serialized).not.toContain('9999')
    expect(changes.map((change) => change.path).sort()).toEqual(['hash', 'password', 'pin'])
    expect(changes.every((change) => change.newValue === REDACTED_VALUE)).toBe(true)
  })

  it('ignores hidden fields that the saved document does not return', () => {
    const before = projectBeforeOntoAfter(
      { email: 'a@example.com', hash: 'stored-hash', salt: 'stored-salt', loginAttempts: 0 },
      { email: 'b@example.com' },
    )
    const changes = computeFieldDiff(before, { email: 'b@example.com' }, policy)
    expect(changes).toEqual([
      { path: 'email', oldValue: 'a@example.com', newValue: 'b@example.com' },
    ])
    expect(JSON.stringify(changes)).not.toContain('stored-hash')
    expect(JSON.stringify(changes)).not.toContain('stored-salt')
  })

  it('does not emit a row when a secret is unchanged', () => {
    const changes = computeFieldDiff({ hash: 'same' }, { hash: 'same', email: 'a@example.com' }, policy)
    expect(changes.map((change) => change.path)).toEqual(['email'])
  })
})

describe('request metadata', () => {
  it('prefers the Cloudflare client IP over a forwarded chain', () => {
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.10',
      'x-forwarded-for': '198.51.100.4, 10.0.0.1',
      'user-agent': 'AuditTest/1.0',
    })

    expect(readTrustedClientIp(headers)).toBe('203.0.113.10')
    expect(readUntrustedClientIp(headers)).toBe('198.51.100.4')
    expect(
      readRequestMetadata({
        headers,
        user: { id: 7, email: 'ops@example.com' },
      }),
    ).toMatchObject({
      actorId: '7',
      actorRelationshipId: 7,
      actorEmail: 'ops@example.com',
      ipAddress: '203.0.113.10',
      untrustedClientIp: '198.51.100.4',
      userAgent: 'AuditTest/1.0',
    })
  })

  it('does not treat a forwarded hop as the trusted client IP', () => {
    const headers = new Headers({
      'x-forwarded-for': ' 198.51.100.4 , 10.0.0.1 ',
      'x-real-ip': '203.0.113.9',
    })
    expect(readTrustedClientIp(headers)).toBeNull()
    expect(readUntrustedClientIp(headers)).toBe('198.51.100.4')
    expect(readRequestMetadata({ headers, user: null }).ipAddress).toBeNull()
  })

  it('keeps x-real-ip untrusted when it is the only hint', () => {
    const headers = new Headers({ 'x-real-ip': '203.0.113.9' })
    expect(readTrustedClientIp(headers)).toBeNull()
    expect(readUntrustedClientIp(headers)).toBe('203.0.113.9')
  })
})

describe('audit viewer query', () => {
  it('maps record, collection, and operator filters onto Payload where params', () => {
    const current = new URLSearchParams('limit=10&page=3&where[action][equals]=DELETE')
    const next = applyAuditLogViewerFilters(current, {
      recordId: ' 15 ',
      collection: 'users',
      operator: 'ops@example.com',
    })

    expect(next.get('limit')).toBe('10')
    expect(next.get('page')).toBeNull()
    expect(next.get('where[action][equals]')).toBeNull()
    expect(next.get('where[documentId][equals]')).toBe('15')
    expect(next.get('where[collectionSlug][equals]')).toBe('users')
    expect(next.get('where[actorEmail][contains]')).toBe('ops@example.com')
    expect(readAuditLogViewerFilters(next)).toEqual({
      recordId: '15',
      collection: 'users',
      operator: 'ops@example.com',
    })
  })

  it('treats a numeric operator as an operator id', () => {
    const next = applyAuditLogViewerFilters(new URLSearchParams(), {
      recordId: '',
      collection: '',
      operator: '42',
    })
    expect(next.get('where[operatorId][equals]')).toBe('42')
    expect(readAuditLogViewerFilters(next).operator).toBe('42')
    expect(
      toAuditLogWhere({ recordId: '', collection: '', operator: '42' }),
    ).toEqual({ operatorId: { equals: '42' } })
  })

  it('drops the where clause when every filter is blank', () => {
    expect(toAuditLogWhere({ recordId: '  ', collection: '', operator: '' })).toBeUndefined()
  })
})

describe('fail-open audit write', () => {
  it('swallows a writer failure and reports it without the field values', () => {
    const reported: string[] = []
    const writer = new FailOpenAuditLogWriter(
      {
        write: async () => {
          throw new Error('d1 unavailable')
        },
      },
      (_error, message) => {
        reported.push(message)
      },
    )

    const entry: AuditLogEntry = {
      action: 'UPDATE',
      collectionSlug: 'users',
      documentId: '4',
      occurredAt: '2026-10-10T00:00:00.000Z',
      summary: 'UPDATE users #4 (email)',
      changes: [{ path: 'email', oldValue: 'a', newValue: 'b' }],
      metadata: {
        actorId: '1',
        actorRelationshipId: 1,
        actorEmail: 'ops@example.com',
        ipAddress: null,
        untrustedClientIp: null,
        userAgent: null,
      },
    }

    const before = droppedAuditWriteCount()
    return expect(writer.write(entry)).resolves.toBeUndefined().then(() => {
      expect(reported).toEqual([
        'Audit log write failed for UPDATE users #4; the original change was kept.',
      ])
      expect(reported.join('')).not.toContain('ops@example.com')
      expect(droppedAuditWriteCount()).toBe(before + 1)
    })
  })

  it('keeps the caller moving when the diff itself throws', async () => {
    const exploding = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('unreadable document')
        },
      },
    )
    const messages: string[] = []

    await expect(
      runAuditChange({
        captured: undefined,
        collectionSlug: 'media',
        data: { alt: 'x' },
        doc: { id: 1, alt: 'x' },
        fields: [],
        metadata: {
          actorId: null,
          actorRelationshipId: null,
          actorEmail: null,
          ipAddress: null,
          untrustedClientIp: null,
          userAgent: null,
        },
        onFailure: (_error, message) => {
          messages.push(message)
        },
        operation: 'update',
        policy,
        previousDoc: exploding,
        writer: {
          write: async () => {
            throw new Error('should not be called')
          },
        },
      }),
    ).resolves.toBeUndefined()

    expect(messages[0]).toContain('the original change was kept')
  })
})

describe('summary', () => {
  it('lists the first changed paths', () => {
    expect(
      buildChangeSummary({
        action: 'UPDATE',
        collectionSlug: 'media',
        documentId: '9',
        changes: [{ path: 'alt' }, { path: 'filename' }],
      }),
    ).toBe('UPDATE media #9 (alt, filename)')
  })
})

describe('relationship normalization', () => {
  const fields = [
    { name: 'owner', type: 'relationship', relationTo: 'users' },
    { name: 'watchers', type: 'relationship', relationTo: 'users', hasMany: true },
    { name: 'pointer', type: 'relationship', relationTo: ['users', 'media'] },
    { name: 'file', type: 'upload', relationTo: 'media' },
    { name: 'title', type: 'text' },
  ]

  it('collapses populated relationships and uploads to ids', () => {
    const before = normalizeRelations(
      {
        owner: 4,
        watchers: [4, 5],
        pointer: { relationTo: 'users', value: 4 },
        file: 9,
        title: 'old',
      },
      fields,
    )
    const after = normalizeRelations(
      {
        owner: { id: 4, email: 'hidden@example.com' },
        watchers: [{ id: 4, email: 'hidden@example.com' }, { id: 5 }],
        pointer: { relationTo: 'users', value: { id: 4, email: 'hidden@example.com' } },
        file: { id: 9, filename: 'dot.png', url: 'https://example.test/dot.png' },
        title: 'old',
      },
      fields,
    )

    expect(after).toEqual(before)
    expect(JSON.stringify(after)).not.toContain('hidden@example.com')
    expect(JSON.stringify(after)).not.toContain('dot.png')
    expect(computeFieldDiff(before, after, policy)).toEqual([])
  })
})

describe('audit capture pairing', () => {
  it('does not reuse a leftover capture from a different document', () => {
    const req = { context: {} } as PayloadRequest
    const failedData = { title: 'from-a' }
    const nextData = { title: 'from-b' }
    rememberAuditCapture(req, {
      collectionSlug: 'audit-subjects',
      data: failedData,
      documentId: '1',
      captured: { submittedSecretPaths: ['password'] },
    })
    rememberAuditCapture(req, {
      collectionSlug: 'audit-subjects',
      data: nextData,
      documentId: '2',
      captured: { submittedSecretPaths: [] },
    })

    expect(
      takeAuditCapture(req, { collectionSlug: 'audit-subjects', data: nextData, documentId: '2' })
        ?.submittedSecretPaths,
    ).toEqual([])
    expect(
      takeAuditCapture(req, { collectionSlug: 'audit-subjects', data: failedData, documentId: '1' })
        ?.submittedSecretPaths,
    ).toEqual(['password'])
    expect(
      takeAuditCapture(req, { collectionSlug: 'audit-subjects', data: failedData, documentId: '1' }),
    ).toBeUndefined()
  })

  it('replaces a failed write so the next write of the same id does not inherit it', () => {
    const req = { context: {} } as PayloadRequest
    const first = { title: 'failed' }
    const second = { title: 'ok' }
    rememberAuditCapture(req, {
      collectionSlug: 'audit-subjects',
      data: first,
      documentId: '8',
      captured: { submittedSecretPaths: ['password'] },
    })
    rememberAuditCapture(req, {
      collectionSlug: 'audit-subjects',
      data: second,
      documentId: '8',
      captured: { submittedSecretPaths: [] },
    })

    expect(
      takeAuditCapture(req, { collectionSlug: 'audit-subjects', data: second, documentId: '8' })
        ?.submittedSecretPaths,
    ).toEqual([])
  })
})

describe('sensitive names', () => {
  it('redacts otp, pin, and ssn without an extra field list', () => {
    const bare = SensitiveFieldPolicy.fromExtraFields()
    const changes = computeFieldDiff(
      { otp: '111111', ssn: '000-00-0000', pin: '1234', name: 'Ada' },
      { otp: '222222', ssn: '111-11-1111', pin: '9999', name: 'Ada' },
      bare,
    )
    const serialized = JSON.stringify(changes)
    expect(serialized).not.toContain('111111')
    expect(serialized).not.toContain('222222')
    expect(serialized).not.toContain('000-00-0000')
    expect(serialized).not.toContain('1234')
    expect(changes.map((change) => change.path).sort()).toEqual(['otp', 'pin', 'ssn'])
  })
})

describe('change row cap', () => {
  it('keeps a redacted password row when the cap would otherwise drop it', () => {
    const ordinary: { path: string; oldValue: string; newValue: string }[] = Array.from(
      { length: MAX_CHANGE_ROWS + 5 },
      (_, index) => ({
        path: `field-${String(index).padStart(2, '0')}`,
        oldValue: `before-${index}`,
        newValue: `after-${index}`,
      }),
    )
    const password = {
      path: 'password',
      oldValue: null as string | null,
      newValue: REDACTED_VALUE,
    }
    const capped = capFieldChanges([...ordinary, password], SensitiveFieldPolicy.fromExtraFields())

    expect(capped).toHaveLength(MAX_CHANGE_ROWS)
    expect(capped.at(-1)).toMatchObject({ path: '_truncated' })
    expect(capped.some((change) => change.path === 'password' && change.newValue === REDACTED_VALUE)).toBe(
      true,
    )
    expect(capped.some((change) => change.path === 'field-68')).toBe(false)
  })
})

describe('partial audit batches', () => {
  it('rejects and deletes the log when a later batch fails', async () => {
    const deleted: number[] = []
    const writer = new PayloadAuditLogWriter({
      create: async () => ({ id: 9 }),
      delete: async (args: { id: number }) => {
        deleted.push(args.id)
        return { id: args.id }
      },
      logger: { error() {} },
      update: async () => {
        throw new Error('later batch failed')
      },
    } as never)

    await expect(writer.write(wideEntry())).rejects.toThrow(/later batch failed/)
    expect(deleted).toEqual([9])
  })

  it('marks the log incomplete when the partial row cannot be removed', async () => {
    const marks: { data?: { summary?: string; changes?: { path: string }[] } }[] = []
    const writer = new PayloadAuditLogWriter({
      create: async () => ({ id: 4 }),
      db: {
        updateOne: async (args: { data?: { summary?: string; changes?: { path: string }[] } }) => {
          marks.push(args)
        },
      },
      delete: async () => {
        throw new Error('delete blocked')
      },
      logger: { error() {} },
      update: async () => {
        throw new Error('later batch failed')
      },
    } as never)

    await expect(writer.write(wideEntry())).resolves.toBeUndefined()
    expect(marks[0]?.data?.summary).toContain('[incomplete]')
    expect(marks[0]?.data?.changes?.some((change) => change.path === '_partial')).toBe(true)
  })
})

describe('an entry whose operator row was just deleted', () => {
  const withActor = (): AuditLogEntry => {
    const base = wideEntry()
    return {
      ...base,
      action: 'DELETE',
      changes: [],
      metadata: { ...base.metadata, actorRelationshipId: 7, actorId: '7' },
    }
  }

  it('is written again without the relationship when the driver error is on the cause', async () => {
    const created: { actor?: number | null; operatorId?: string | null }[] = []
    const writer = new PayloadAuditLogWriter({
      create: async (args: { data: { actor?: number | null; operatorId?: string | null } }) => {
        created.push({ actor: args.data.actor, operatorId: args.data.operatorId })
        if (args.data.actor != null) {
          // What drizzle throws: the message has the SQL, the driver's text is on `cause`.
          throw new Error('Failed query: insert into "audit_logs" ...', {
            cause: new Error('D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT'),
          })
        }
        return { id: 3 }
      },
      logger: { error() {} },
    } as never)

    await writer.write(withActor())
    expect(created).toEqual([
      { actor: 7, operatorId: '7' },
      { actor: null, operatorId: '7' },
    ])
  })

  it('does not retry an error that is not a foreign key failure', async () => {
    let calls = 0
    const writer = new PayloadAuditLogWriter({
      create: async () => {
        calls += 1
        throw new Error('Failed query: ...', { cause: new Error('D1_ERROR: database is locked') })
      },
      logger: { error() {} },
    } as never)

    await expect(writer.write(withActor())).rejects.toThrow(/Failed query/)
    expect(calls).toBe(1)
  })
})

function wideEntry(): AuditLogEntry {
  const changes = Array.from({ length: CHANGE_ROW_INSERT_CHUNK + 1 }, (_, index) => ({
    path: `field${index}`,
    oldValue: 'before',
    newValue: 'after',
  }))
  return {
    action: 'UPDATE',
    changes,
    collectionSlug: 'audit-subjects',
    documentId: '1',
    metadata: {
      actorEmail: null,
      actorId: null,
      actorRelationshipId: null,
      ipAddress: null,
      untrustedClientIp: null,
      userAgent: null,
    },
    occurredAt: '2026-10-10T00:00:00.000Z',
    summary: 'UPDATE audit-subjects #1',
  }
}

describe('custom.audit.redact whenSensitive', () => {
  const fields = [
    {
      name: 'value',
      type: 'json',
      custom: { audit: { redact: 'whenSensitive' } },
    },
    { name: 'sensitive', type: 'checkbox' },
    { name: 'key', type: 'text' },
  ]
  const metadata: RequestAuditMetadata = {
    actorId: null,
    actorRelationshipId: null,
    actorEmail: null,
    ipAddress: null,
    untrustedClientIp: null,
    userAgent: null,
  }

  async function loggedChanges(args: {
    data: Record<string, unknown>
    doc: Record<string, unknown>
    previousDoc: Record<string, unknown>
  }) {
    const entries: Array<{ changes: Array<{ path: string; oldValue: unknown; newValue: unknown }> }> = []
    await runAuditChange({
      captured: undefined,
      collectionSlug: 'system-parameters',
      data: args.data,
      doc: args.doc,
      fields,
      metadata,
      onFailure: () => {},
      operation: 'update',
      policy: SensitiveFieldPolicy.fromExtraFields(),
      previousDoc: args.previousDoc,
      writer: {
        write: async (entry) => {
          entries.push(entry)
        },
      },
    })
    return entries[0]?.changes ?? []
  }

  it('redacts a sensitive system-parameter value and keeps a non-sensitive one', async () => {
    const secret = 'billing-allowlist-secret'
    const nextSecret = 'billing-allowlist-next'
    const sensitive = await loggedChanges({
      data: { value: nextSecret, sensitive: true },
      previousDoc: { id: 4, key: 'billing-allowlist', sensitive: true, value: secret },
      doc: { id: 4, key: 'billing-allowlist', sensitive: true, value: nextSecret },
    })
    const valueChange = sensitive.find((change) => change.path === 'value')
    expect(valueChange).toMatchObject({ oldValue: REDACTED_VALUE, newValue: REDACTED_VALUE })
    expect(JSON.stringify(sensitive)).not.toContain(secret)
    expect(JSON.stringify(sensitive)).not.toContain(nextSecret)

    const plain = 'public-banner'
    const open = await loggedChanges({
      data: { value: plain, sensitive: false },
      previousDoc: { id: 5, key: 'banner', sensitive: false, value: 'old-banner' },
      doc: { id: 5, key: 'banner', sensitive: false, value: plain },
    })
    expect(open.find((change) => change.path === 'value')).toMatchObject({
      oldValue: 'old-banner',
      newValue: plain,
    })
  })
})
