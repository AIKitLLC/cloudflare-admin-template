import type { PayloadRequest } from 'payload'

import { evaluateCollectionAccess } from './evaluate-collection-access'
import { globalAccessSlug } from './global-slug'
import { isAccessGranted } from './result'

export function globalOperation(slug: string, action: 'read' | 'update') {
  return async ({ req }: { req: PayloadRequest }): Promise<boolean> => {
    const decision = await evaluateCollectionAccess({
      req,
      collectionSlug: globalAccessSlug(slug),
      action,
    })
    return isAccessGranted(decision)
  }
}
