import type { CollectionConfig, Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { adminAudit } from './plugin'

describe('@aikit/admin-audit', () => {
  it('wraps the named collection and adds a closed audit log', () => {
    const pages: CollectionConfig = { slug: 'pages', fields: [] }
    const config = adminAudit({ trails: [{ slug: 'pages', redactFields: ['token'] }] })({
      collections: [pages],
    } as Config)
    if (config instanceof Promise) throw new Error('adminAudit is synchronous')
    const wrapped = config.collections?.find((collection) => collection.slug === 'pages')
    const custom = wrapped?.custom as { auditTrail?: { enabled?: boolean; redactFields?: string[] } }
    expect(custom.auditTrail?.enabled).toBe(true)
    expect(custom.auditTrail?.redactFields).toEqual(['token'])
    const logs = config.collections?.find((collection) => collection.slug === 'audit-logs')
    const rbac = (logs?.custom as { rbac?: { ownsAccess?: boolean; enabled?: boolean } }).rbac
    expect(rbac?.ownsAccess).toBe(true)
    expect(rbac?.enabled).toBeUndefined()
  })
})