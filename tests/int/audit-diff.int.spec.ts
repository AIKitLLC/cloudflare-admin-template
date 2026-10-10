import { describe, expect, it } from 'vitest'

import { REDACTED_VALUE } from '@/audit/constants'
import {
  applyAuditLogViewerFilters,
  readAuditLogViewerFilters,
  toAuditLogWhere,
} from '@/audit/admin/auditLogViewerQuery'
import { buildChangeSummary } from '@/audit/diff/buildChangeSummary'
import { computeFieldDiff } from '@/audit/diff/computeFieldDiff'
import { projectBeforeOntoAfter } from '@/audit/diff/projectBeforeOntoAfter'
import { SensitiveFieldPolicy } from '@/audit/diff/SensitiveFieldPolicy'
import { FailOpenAuditLogWriter } from '@/audit/logging/FailOpenAuditLogWriter'
import { runAuditChange } from '@/audit/logging/runAuditRecord'
import { readClientIp, readRequestMetadata } from '@/audit/request/readRequestMetadata'
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

    expect(readClientIp(headers)).toBe('203.0.113.10')
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
      userAgent: 'AuditTest/1.0',
    })
  })

  it('uses the first forwarded hop when Cloudflare does not set a client IP', () => {
    const headers = new Headers({ 'x-forwarded-for': ' 198.51.100.4 , 10.0.0.1 ' })
    expect(readClientIp(headers)).toBe('198.51.100.4')
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
        userAgent: null,
      },
    }

    return expect(writer.write(entry)).resolves.toBeUndefined().then(() => {
      expect(reported).toEqual([
        'Audit log write failed for UPDATE users #4; the original change was kept.',
      ])
      expect(reported.join('')).not.toContain('ops@example.com')
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
        metadata: {
          actorId: null,
          actorRelationshipId: null,
          actorEmail: null,
          ipAddress: null,
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
