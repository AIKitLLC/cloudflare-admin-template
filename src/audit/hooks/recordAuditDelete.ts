import type { CollectionAfterDeleteHook } from 'payload'

import { AUDIT_LOGS_SLUG } from '../constants'
import type { SensitiveFieldPolicy } from '../diff/SensitiveFieldPolicy'
import { FailOpenAuditLogWriter } from '../logging/FailOpenAuditLogWriter'
import { PayloadAuditLogWriter } from '../logging/PayloadAuditLogWriter'
import { droppedAuditWriteCount } from '../logging/droppedAuditWrites'
import { runAuditDelete } from '../logging/runAuditRecord'
import { readRequestMetadata } from '../request/readRequestMetadata'

export function recordAuditDelete(policy: SensitiveFieldPolicy): CollectionAfterDeleteHook {
  return async ({ collection, doc, id, req }) => {
    if (collection.slug === AUDIT_LOGS_SLUG) return

    const writer = new FailOpenAuditLogWriter(new PayloadAuditLogWriter(req.payload), (error, message) => {
      req.payload.logger.error({
        droppedAuditWrites: droppedAuditWriteCount(),
        err: error,
        msg: message,
      })
    })

    await runAuditDelete({
      collectionSlug: collection.slug,
      doc,
      fields: collection.fields,
      id,
      metadata: readRequestMetadata(req),
      onFailure: (error, message) => {
        req.payload.logger.error({
          droppedAuditWrites: droppedAuditWriteCount(),
          err: error,
          msg: message,
        })
      },
      policy,
      writer,
    })
  }
}
