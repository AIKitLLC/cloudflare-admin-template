import type { PayloadRequest } from 'payload'

import { EFFECTIVE_SCOPE_CACHE_KEY, SCOPE_CATALOG_CACHE_KEY } from '../constants'
import type { ScopeCatalog } from '../types'
import type { EffectiveScope } from '../types'

type EffectiveCache = {
  userId: string
  promise: Promise<EffectiveScope>
}

export function readCatalogPromise(req: PayloadRequest): Promise<ScopeCatalog> | undefined {
  return req.context?.[SCOPE_CATALOG_CACHE_KEY] as Promise<ScopeCatalog> | undefined
}

export function storeCatalogPromise(req: PayloadRequest, promise: Promise<ScopeCatalog>): void {
  ensureContext(req)
  req.context[SCOPE_CATALOG_CACHE_KEY] = promise
}

export function clearCatalogPromise(req: PayloadRequest): void {
  if (!req.context) {
    return
  }
  delete req.context[SCOPE_CATALOG_CACHE_KEY]
}

export function readEffectivePromise(
  req: PayloadRequest,
  userId: string,
): Promise<EffectiveScope> | undefined {
  const cached = req.context?.[EFFECTIVE_SCOPE_CACHE_KEY] as EffectiveCache | undefined
  if (cached?.userId === userId) {
    return cached.promise
  }
  return undefined
}

export function storeEffectivePromise(
  req: PayloadRequest,
  userId: string,
  promise: Promise<EffectiveScope>,
): void {
  ensureContext(req)
  req.context[EFFECTIVE_SCOPE_CACHE_KEY] = { userId, promise } satisfies EffectiveCache
}

export function clearScopeRequestCache(req: PayloadRequest): void {
  if (!req.context) {
    return
  }
  delete req.context[SCOPE_CATALOG_CACHE_KEY]
  delete req.context[EFFECTIVE_SCOPE_CACHE_KEY]
}

function ensureContext(req: PayloadRequest): void {
  if (!req.context) {
    req.context = {}
  }
}
