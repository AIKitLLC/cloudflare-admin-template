import { randomUUID } from 'node:crypto'

import { getPayload, type Payload } from 'payload'
import config from '@/payload.config'
import { beforeAll, describe, expect, it } from 'vitest'

import { REDACTED_VALUE } from '@/audit/constants'

let payload: Payload

describe('audit logs', () => {
  beforeAll(async () => {
    const payloadConfig = await config
    payload = await getPayload({ config: payloadConfig })
  })

  it('records field diffs, redacts secrets, and stays append-only', async () => {
    const password = `pw-do-not-log-${randomUUID()}`
    const email = `audit-${randomUUID()}@example.com`
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.42',
      'user-agent': 'AuditTrailIntegration/1.0',
    })

    const beforeOperator = await latestAuditId()
    const operator = await payload.create({
      collection: 'users',
      data: { email, password },
      overrideAccess: true,
    })

    const createdLogs = (await findLogs({
      action: 'CREATE',
      collectionSlug: 'users',
      documentId: String(operator.id),
    })).filter((log) => log.id > beforeOperator)
    expect(createdLogs).toHaveLength(1)
    const createdBlob = JSON.stringify(createdLogs)
    expect(createdBlob).not.toContain(password)
    expect(createdBlob).toContain(REDACTED_VALUE)
    expect(createdLogs[0]?.actor).toBeNull()
    expect(changeByPath(createdLogs[0], 'password')?.newValue).toBe(REDACTED_VALUE)
    expect(changeByPath(createdLogs[0], 'email')?.newValue).toBe(email)

    const nextEmail = `updated-${email}`
    const beforeEmailUpdate = await latestAuditId()
    await payload.update({
      collection: 'users',
      id: operator.id,
      data: { email: nextEmail },
      overrideAccess: true,
      user: operator,
      req: { headers },
    })

    const emailLogs = (await findLogs({
      action: 'UPDATE',
      collectionSlug: 'users',
      documentId: String(operator.id),
    })).filter((log) => log.id > beforeEmailUpdate)
    expect(emailLogs).toHaveLength(1)
    expect(changeByPath(emailLogs[0], 'email')).toMatchObject({
      oldValue: email,
      newValue: nextEmail,
    })
    expect(emailLogs[0]?.operatorId).toBe(String(operator.id))
    expect(emailLogs[0]?.actorEmail).toBe(email)
    expect(emailLogs[0]?.ipAddress).toBe('203.0.113.42')
    expect(emailLogs[0]?.userAgent).toBe('AuditTrailIntegration/1.0')
    expect(JSON.stringify(emailLogs)).not.toContain(password)

    const beforeNoop = await latestAuditId()
    await payload.update({
      collection: 'users',
      id: operator.id,
      data: { email: nextEmail },
      overrideAccess: true,
      user: operator,
    })
    const afterNoop = (await findLogs({
      action: 'UPDATE',
      collectionSlug: 'users',
      documentId: String(operator.id),
    })).filter((log) => log.id > beforeNoop)
    expect(afterNoop).toHaveLength(0)

    const beforePassword = await latestAuditId()
    await payload.update({
      collection: 'users',
      id: operator.id,
      data: { password: `${password}-rotated` },
      overrideAccess: true,
      user: operator,
    })
    const passwordLogs = (await findLogs({
      action: 'UPDATE',
      collectionSlug: 'users',
      documentId: String(operator.id),
    })).filter((log) => log.id > beforePassword)
    const passwordBlob = JSON.stringify(passwordLogs)
    expect(passwordBlob).not.toContain(password)
    expect(passwordBlob).not.toContain(`${password}-rotated`)
    expect(passwordBlob).toContain(REDACTED_VALUE)

    const beforeMedia = await latestAuditId()
    const alt = `Banner ${randomUUID()}`
    const file = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const media = await payload.create({
      collection: 'media',
      data: { alt },
      file: {
        data: file,
        mimetype: 'image/png',
        name: 'dot.png',
        size: file.length,
      },
      overrideAccess: true,
      user: operator,
      req: { headers },
    })
    const nextAlt = `${alt} edited`
    await payload.update({
      collection: 'media',
      id: media.id,
      data: { alt: nextAlt },
      overrideAccess: true,
      user: operator,
    })
    await payload.delete({
      collection: 'media',
      id: media.id,
      overrideAccess: true,
      user: operator,
    })

    const mediaLogs = (await findLogs({
      collectionSlug: 'media',
      documentId: String(media.id),
    })).filter((log) => log.id > beforeMedia)
    expect(mediaLogs.map((log) => log.action).sort()).toEqual(['CREATE', 'DELETE', 'UPDATE'])
    const mediaUpdate = mediaLogs.find((log) => log.action === 'UPDATE')
    expect(changeByPath(mediaUpdate, 'alt')).toMatchObject({ oldValue: alt, newValue: nextAlt })
    const mediaDelete = mediaLogs.find((log) => log.action === 'DELETE')
    expect(changeByPath(mediaDelete, 'alt')?.oldValue).toBe(nextAlt)

    const outsider = await payload.create({
      collection: 'users',
      data: { email: `outsider-${randomUUID()}@example.com`, password: `pw-${randomUUID()}` },
      overrideAccess: true,
    })
    await expect(
      payload.find({
        collection: 'audit-logs',
        overrideAccess: false,
        user: outsider,
      }),
    ).rejects.toThrow()

    await expect(
      payload.find({
        collection: 'audit-logs',
        overrideAccess: false,
      }),
    ).rejects.toThrow()

    const sample = mediaLogs[0]
    expect(sample?.id).toBeDefined()
    await expect(
      payload.update({
        collection: 'audit-logs',
        id: sample!.id,
        data: { summary: 'tampered' },
        overrideAccess: true,
      }),
    ).rejects.toThrow(/append-only/i)
    await expect(
      payload.delete({
        collection: 'audit-logs',
        id: sample!.id,
        overrideAccess: true,
      }),
    ).rejects.toThrow(/append-only/i)

    await payload.delete({
      collection: 'users',
      id: operator.id,
      overrideAccess: true,
    })
    const surviving = await payload.find({
      collection: 'audit-logs',
      overrideAccess: true,
      where: {
        operatorId: { equals: String(operator.id) },
      },
    })
    expect(surviving.docs.length).toBeGreaterThan(0)
    expect(surviving.docs.every((log) => log.actor == null || log.actor === operator.id)).toBe(true)
    expect(surviving.docs.some((log) => log.actorEmail === email)).toBe(true)
    expect(JSON.stringify(surviving.docs)).not.toContain(password)
  })
})

async function latestAuditId(): Promise<number> {
  const result = await payload.find({
    collection: 'audit-logs',
    limit: 1,
    overrideAccess: true,
    sort: '-id',
  })
  return result.docs[0]?.id ?? 0
}

async function findLogs(where: { action?: string; collectionSlug: string; documentId: string }) {
  const and: Record<string, { equals: string }>[] = [
    { collectionSlug: { equals: where.collectionSlug } },
    { documentId: { equals: where.documentId } },
  ]
  if (where.action) and.unshift({ action: { equals: where.action } })

  const result = await payload.find({
    collection: 'audit-logs',
    depth: 0,
    limit: 50,
    overrideAccess: true,
    sort: 'createdAt',
    where: { and },
  })
  return result.docs
}

function changeByPath(
  log: { changes?: { path: string; oldValue?: unknown; newValue?: unknown }[] | null } | undefined,
  path: string,
) {
  return log?.changes?.find((change) => change.path === path)
}
