import type { CollectionConfig } from 'payload'

import { AUDIT_LOGS_SLUG } from '../constants'
import { SensitiveFieldPolicy } from '../diff/SensitiveFieldPolicy'
import { captureAuditContext } from './captureAuditContext'
import { recordAuditChange } from './recordAuditChange'
import { recordAuditDelete } from './recordAuditDelete'

export type AuditTrailOptions = {
  /**
   * Extra field names or dotted paths to redact, in addition to the defaults
   * (password, hash, salt, token, secret, session, and similar).
   */
  redactFields?: readonly string[]
}

/**
 * Decorator: opts a collection into field-level audit logging.
 *
 *   export const Customers = withAuditTrail({ slug: 'customers', fields: [...] })
 *
 * Audit Logs itself cannot be wrapped. That would recurse on every insert.
 */
export function withAuditTrail<T extends CollectionConfig>(
  collection: T,
  options: AuditTrailOptions = {},
): T {
  if (collection.slug === AUDIT_LOGS_SLUG) {
    throw new Error(
      'Audit Logs cannot use withAuditTrail. Logging that collection would recurse.',
    )
  }

  const policy = SensitiveFieldPolicy.fromExtraFields(options.redactFields)

  return {
    ...collection,
    custom: {
      ...collection.custom,
      auditTrail: {
        enabled: true,
        redactFields: [...(options.redactFields ?? [])],
      },
    },
    hooks: {
      ...collection.hooks,
      beforeChange: [captureAuditContext(policy), ...(collection.hooks?.beforeChange ?? [])],
      afterChange: [...(collection.hooks?.afterChange ?? []), recordAuditChange(policy)],
      afterDelete: [...(collection.hooks?.afterDelete ?? []), recordAuditDelete(policy)],
    },
  }
}
