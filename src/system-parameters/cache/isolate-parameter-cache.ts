import type { Payload } from 'payload'

import { PARAMETER_CACHE_MAX_AGE_MS, PARAMETER_CACHE_VERIFY_TTL_MS } from '../constants'
import { loadParameter } from '../read/load-parameter'
import { createPayloadVersionStore } from './version-store'
import {
  createIsolateMemory,
  kvReaders,
  ParameterReadCache,
  type IsolateMemory,
} from './parameter-read-cache'

const isolateMemory = createIsolateMemory()

export function isolateParameterCache(payload: Payload): ParameterReadCache {
  return new ParameterReadCache({
    memory: isolateMemory,
    versions: createPayloadVersionStore(payload),
    load: (key) => loadParameter(payload, key),
    ...kvReaders(),
    now: () => Date.now(),
    verifyTtlMs: PARAMETER_CACHE_VERIFY_TTL_MS,
    maxAgeMs: PARAMETER_CACHE_MAX_AGE_MS,
  })
}

export function invalidateIsolateParameterMemory(): void {
  isolateMemory.version = null
  isolateMemory.verifiedAt = 0
  isolateMemory.loadedAt = null
  isolateMemory.entries.clear()
}

export function readIsolateMemory(): IsolateMemory {
  return isolateMemory
}
