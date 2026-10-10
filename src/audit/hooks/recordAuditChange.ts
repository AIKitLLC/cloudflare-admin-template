import type { CollectionAfterChangeHook } from 'payload'

import { AUDIT_LOGS_SLUG } from '../constants'
import type { SensitiveFieldPolicy } from '../diff/SensitiveFieldPolicy'
import { FailOpenAuditLogWriter } from '../logging/FailOpenAuditLogWriter'
import { PayloadAuditLogWriter } from '../logging/PayloadAuditLogWriter'
import { runAuditChange } from '../logging/runAuditRecord'
import { popAuditContext } from '../request/AuditContextStore'
import { readRequestMetadata } from '../request/readRequestMetadata'

export function recordAuditChange(policy: SensitiveFieldPolicy): CollectionAfterChangeHook {
  return async ({ collection, data, doc, operation, previousDoc, req }) => {
    if (collection.slug === AUDIT_LOGS_SLUG) return doc

    const captured = popAuditContext(req, collection.slug)
    const writer = new FailOpenAuditLogWriter(
      new PayloadAuditLogWriter(req.payload),
      (error, message) => {
        req.payload.logger.error({ err: error, msg: message })
      },
    )

    await runAuditChange({
      captured,
      collectionSlug: collection.slug,
      data,
      doc,
      metadata: captured?.metadata ?? readRequestMetadata(req),
      onFailure: (error, message) => {
        req.payload.logger.error({ err: error, msg: message })
      },
      operation,
      policy,
      previousDoc,
      writer,
    })

    return doc
  }
}
