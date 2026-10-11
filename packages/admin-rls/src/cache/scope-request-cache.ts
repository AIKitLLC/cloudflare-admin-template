import type { PayloadRequest, Where } from 'payload'

import {
  EFFECTIVE_SCOPE_CACHE_KEY,
  SCOPE_CATALOG_CACHE_KEY,
  VISIBLE_USERS_CACHE_KEY,
} from '../constants'
import type { EffectiveScope, ScopeCatalog } from '../types'

type EffectiveCache = {
  userId: string
  promise: Promise<EffectiveScope>
}

type VisibleUsersCache = {
  userId: string
  promise: Promise<Where>
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

export function readVisibleUsersPromise(
  req: PayloadRequest,
  userId: string,
): Promise<Where> | undefined {
  const cached = req.context?.[VISIBLE_USERS_CACHE_KEY] as VisibleUsersCache | undefined
  if (cached?.userId === userId) {
    return cached.promise
  }
  return undefined
}

export function storeVisibleUsersPromise(
  req: PayloadRequest,
  userId: string,
  promise: Promise<Where>,
): void {
  ensureContext(req)
  req.context[VISIBLE_USERS_CACHE_KEY] = { userId, promise } satisfies VisibleUsersCache
}

export function clearScopeRequestCache(req: PayloadRequest): void {
  if (!req.context) {
    return
  }
  delete req.context[SCOPE_CATALOG_CACHE_KEY]
  delete req.context[EFFECTIVE_SCOPE_CACHE_KEY]
  delete req.context[VISIBLE_USERS_CACHE_KEY]
}

function ensureContext(req: PayloadRequest): void {
  if (!req.context) {
    req.context = {}
  }
}
