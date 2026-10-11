import type { CollectionAfterChangeHook, CollectionAfterDeleteHook } from 'payload'

import { clearScopeRequestCache } from '../cache/scope-request-cache'

export const clearScopeCacheAfterChange: CollectionAfterChangeHook = ({ req }) => {
  clearScopeRequestCache(req)
}

export const clearScopeCacheAfterDelete: CollectionAfterDeleteHook = ({ req }) => {
  clearScopeRequestCache(req)
}
