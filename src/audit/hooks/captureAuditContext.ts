import type { CollectionBeforeChangeHook, CollectionBeforeDeleteHook } from 'payload'

import type { SensitiveFieldPolicy } from '../diff/SensitiveFieldPolicy'
import { submittedSecretPaths } from '../diff/submittedSecretPaths'
import { cloneRecord, pushAuditContext } from '../request/AuditContextStore'
import { readRequestMetadata } from '../request/readRequestMetadata'

/**
 * beforeChange: snapshot the pre-write document and the caller metadata.
 * afterChange reads this snapshot so later hooks cannot mutate the "before" side.
 * A capture failure must not reject the user's write.
 */
export function captureAuditContext(policy: SensitiveFieldPolicy): CollectionBeforeChangeHook {
  return ({ collection, data, originalDoc, operation, req }) => {
    try {
      pushAuditContext(req, collection.slug, {
        originalDoc: operation === 'create' ? null : cloneRecord(originalDoc),
        metadata: readRequestMetadata(req),
        submittedSecretPaths: submittedSecretPaths(data, originalDoc, policy),
      })
    } catch (error) {
      req.payload.logger.error({
        err: error,
        msg: `Audit context capture failed for ${collection.slug}; the change will continue.`,
      })
    }
    return data
  }
}

export const captureDeleteContext: CollectionBeforeDeleteHook = ({ collection, req }) => {
  try {
    pushAuditContext(req, collection.slug, {
      originalDoc: null,
      metadata: readRequestMetadata(req),
      submittedSecretPaths: [],
    })
  } catch (error) {
    req.payload.logger.error({
      err: error,
      msg: `Audit context capture failed for delete of ${collection.slug}; the change will continue.`,
    })
  }
}
