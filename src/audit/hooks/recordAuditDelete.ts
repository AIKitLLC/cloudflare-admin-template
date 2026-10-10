import type { CollectionAfterDeleteHook } from 'payload'

import { AUDIT_LOGS_SLUG } from '../constants'
import type { SensitiveFieldPolicy } from '../diff/SensitiveFieldPolicy'
import { FailOpenAuditLogWriter } from '../logging/FailOpenAuditLogWriter'
import { PayloadAuditLogWriter } from '../logging/PayloadAuditLogWriter'
import { runAuditDelete } from '../logging/runAuditRecord'
import { popAuditContext } from '../request/AuditContextStore'
import { readRequestMetadata } from '../request/readRequestMetadata'

export function recordAuditDelete(policy: SensitiveFieldPolicy): CollectionAfterDeleteHook {
  return async ({ collection, doc, id, req }) => {
    if (collection.slug === AUDIT_LOGS_SLUG) return

    const captured = popAuditContext(req, collection.slug)
    const writer = new FailOpenAuditLogWriter(
      new PayloadAuditLogWriter(req.payload),
      (error, message) => {
        req.payload.logger.error({ err: error, msg: message })
      },
    )

    await runAuditDelete({
      collectionSlug: collection.slug,
      doc,
      id,
      metadata: captured?.metadata ?? readRequestMetadata(req),
      onFailure: (error, message) => {
        req.payload.logger.error({ err: error, msg: message })
      },
      policy,
      writer,
    })
  }
}
