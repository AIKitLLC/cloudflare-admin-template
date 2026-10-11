import type { CollectionAfterChangeHook } from 'payload'

import { AUDIT_LOGS_SLUG } from '../constants'
import type { SensitiveFieldPolicy } from '../diff/SensitiveFieldPolicy'
import { FailOpenAuditLogWriter } from '../logging/FailOpenAuditLogWriter'
import { PayloadAuditLogWriter } from '../logging/PayloadAuditLogWriter'
import { droppedAuditWriteCount } from '../logging/droppedAuditWrites'
import { runAuditChange } from '../logging/runAuditRecord'
import { documentIdOf, takeAuditCapture } from '../request/AuditContextStore'
import { readRequestMetadata } from '../request/readRequestMetadata'

export function recordAuditChange(policy: SensitiveFieldPolicy): CollectionAfterChangeHook {
  return async ({ collection, data, doc, operation, previousDoc, req }) => {
    if (collection.slug === AUDIT_LOGS_SLUG) return doc

    const documentId = operation === 'update' ? documentIdOf(doc) ?? documentIdOf(previousDoc) : null
    const captured = takeAuditCapture(req, {
      collectionSlug: collection.slug,
      data,
      documentId,
    })
    const writer = new FailOpenAuditLogWriter(new PayloadAuditLogWriter(req.payload), (error, message) => {
      req.payload.logger.error({
        droppedAuditWrites: droppedAuditWriteCount(),
        err: error,
        msg: message,
      })
    })

    await runAuditChange({
      captured,
      collectionSlug: collection.slug,
      data,
      doc,
      fields: collection.fields,
      metadata: readRequestMetadata(req),
      onFailure: (error, message) => {
        req.payload.logger.error({
          droppedAuditWrites: droppedAuditWriteCount(),
          err: error,
          msg: message,
        })
      },
      operation,
      policy,
      previousDoc,
      writer,
    })

    return doc
  }
}
