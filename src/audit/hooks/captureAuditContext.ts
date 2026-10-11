import type { CollectionBeforeChangeHook } from 'payload'

import type { SensitiveFieldPolicy } from '../diff/SensitiveFieldPolicy'
import { submittedSecretPaths } from '../diff/submittedSecretPaths'
import { documentIdOf, rememberAuditCapture } from '../request/AuditContextStore'

/**
 * beforeChange records only the names of submitted secrets, keyed to this write.
 * The before document is `previousDoc` on afterChange, which Payload binds to
 * this operation. A capture failure must not reject the user's write.
 */
export function captureAuditContext(policy: SensitiveFieldPolicy): CollectionBeforeChangeHook {
  return ({ collection, data, operation, originalDoc, req }) => {
    try {
      rememberAuditCapture(req, {
        captured: {
          submittedSecretPaths: submittedSecretPaths(data, originalDoc, policy),
        },
        collectionSlug: collection.slug,
        data,
        documentId: operation === 'update' ? documentIdOf(originalDoc) : null,
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
