import type { PayloadRequest } from 'payload'

import { EFFECTIVE_SCOPE_CACHE_KEY } from '../constants'
import { readEffectivePromise, storeEffectivePromise } from '../cache/scope-request-cache'
import type { EffectiveScope } from '../types'
import { loadScopeAssignments } from './load-scope-assignments'
import { loadScopeCatalog } from './load-scope-catalog'
import { resolveEffectiveScope } from './resolve-effective-scope'

export async function loadEffectiveScope(req: PayloadRequest): Promise<EffectiveScope> {
  const userId = String(req.user?.id ?? '')
  const cached = readEffectivePromise(req, userId)
  if (cached) {
    return cached
  }
  const pending = computeEffectiveScope(req)
  storeEffectivePromise(req, userId, pending)
  try {
    return await pending
  } catch (error) {
    if (req.context) {
      delete req.context[EFFECTIVE_SCOPE_CACHE_KEY]
    }
    throw error
  }
}

async function computeEffectiveScope(req: PayloadRequest): Promise<EffectiveScope> {
  const [catalog, assignments] = await Promise.all([
    loadScopeCatalog(req),
    loadScopeAssignments(req),
  ])
  return resolveEffectiveScope(catalog, assignments)
}
