import type { CollectionAfterDeleteHook } from 'payload'

import { AUDIT_LOGS_SLUG } from '../constants'
import type { SensitiveFieldPolicy } from '../diff/SensitiveFieldPolicy'
import { FailOpenAuditLogWriter } from '../logging/FailOpenAuditLogWriter'
import { PayloadAuditLogWriter } from '../logging/PayloadAuditLogWriter'
import { droppedAuditWriteCount } from '../logging/droppedAuditWrites'
import { runAuditDelete } from '../logging/runAuditRecord'
import { readRequestMetadata } from '../request/readRequestMetadata'
import type { RequestAuditMetadata } from '../types'

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
      metadata: withoutDeletedActor(readRequestMetadata(req), collection.slug, id, req.user?.collection),
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

/**
 * A user deleting their own account: the actor row is already gone, so the relationship would
 * fail validation and the entry would be dropped. Keep the id and email snapshots instead.
 */
function withoutDeletedActor(
  metadata: RequestAuditMetadata,
  collectionSlug: string,
  id: number | string,
  actorCollection: string | undefined,
): RequestAuditMetadata {
  if (actorCollection !== collectionSlug || metadata.actorId !== String(id)) return metadata
  return { ...metadata, actorRelationshipId: null }
}
