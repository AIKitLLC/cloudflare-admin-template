import type { CollectionConfig, Plugin } from 'payload'

import { AuditLogs } from './collections/AuditLogs'
import { AUDIT_LOGS_SLUG } from './constants'
import { withAuditTrail, type AuditTrailOptions } from './hooks/withAuditTrail'
import './register-audit-permission'

export type AuditTrailTarget = {
  slug: string
} & AuditTrailOptions

type AuditCustom = {
  auditTrail?: {
    enabled?: boolean
  }
}

export const adminAudit =
  (options: { trails?: readonly AuditTrailTarget[] } = {}): Plugin =>
  (incoming) => {
    const trails = new Map((options.trails ?? []).map((trail) => [trail.slug, trail]))
    const collections = (incoming.collections ?? []).map((collection) => wrapTrail(collection, trails))
    if (!collections.some((collection) => collection.slug === AUDIT_LOGS_SLUG)) {
      collections.push(AuditLogs)
    }
    return {
      ...incoming,
      collections,
    }
  }

function wrapTrail(
  collection: CollectionConfig,
  trails: Map<string, AuditTrailTarget>,
): CollectionConfig {
  const trail = trails.get(collection.slug)
  if (!trail) {
    return collection
  }
  const custom = collection.custom as AuditCustom | undefined
  if (custom?.auditTrail?.enabled) {
    return collection
  }
  return withAuditTrail(collection, { redactFields: trail.redactFields })
}
