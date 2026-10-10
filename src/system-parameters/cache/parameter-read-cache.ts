import type { ParameterSnapshot, VersionStore } from '../types'
import { publishParameterKvEntry, readParameterKvEntry } from './kv-binding'

export type IsolateMemory = {
  version: number | null
  verifiedAt: number
  loadedAt: number | null
  entries: Map<string, ParameterSnapshot | null>
}

export function createIsolateMemory(): IsolateMemory {
  return {
    version: null,
    verifiedAt: 0,
    loadedAt: null,
    entries: new Map(),
  }
}

export type ParameterReadCacheDeps = {
  memory: IsolateMemory
  versions: VersionStore
  load: (key: string) => Promise<ParameterSnapshot | null>
  readKv: (key: string, version: number) => Promise<ParameterSnapshot | null | undefined>
  writeKv: (version: number, key: string, snapshot: ParameterSnapshot | null) => Promise<void>
  now: () => number
  verifyTtlMs: number
  maxAgeMs: number
}

export class ParameterReadCache {
  constructor(private readonly deps: ParameterReadCacheDeps) {}

  invalidate(): void {
    this.deps.memory.version = null
    this.deps.memory.verifiedAt = 0
    this.deps.memory.loadedAt = null
    this.deps.memory.entries.clear()
  }

  async read(key: string): Promise<ParameterSnapshot | null> {
    const now = this.deps.now()
    const memory = this.deps.memory
    const memoryStale =
      memory.loadedAt !== null && now - memory.loadedAt >= this.deps.maxAgeMs
    const withinTtl = now - memory.verifiedAt < this.deps.verifyTtlMs
    if (!memoryStale && withinTtl && memory.entries.has(key)) {
      return memory.entries.get(key) ?? null
    }

    const version = await this.deps.versions.readVersion()
    if (!memoryStale && memory.version === version && memory.entries.has(key)) {
      memory.verifiedAt = now
      return memory.entries.get(key) ?? null
    }

    if (!memoryStale) {
      const fromKv = await this.deps.readKv(key, version)
      if (fromKv !== undefined) {
        this.remember(key, fromKv, version, now, false)
        return fromKv
      }
    }

    const loaded = await this.deps.load(key)
    this.remember(key, loaded, version, now, true)
    await this.deps.writeKv(version, key, loaded)
    return loaded
  }

  private remember(
    key: string,
    snapshot: ParameterSnapshot | null,
    version: number,
    now: number,
    refreshLoadedAt: boolean,
  ): void {
    const memory = this.deps.memory
    if (memory.version !== version) {
      memory.entries.clear()
      memory.version = version
      memory.loadedAt = now
    } else if (refreshLoadedAt || memory.loadedAt === null) {
      memory.loadedAt = now
    }
    memory.verifiedAt = now
    memory.entries.set(key, snapshot)
  }
}

export function kvReaders(): Pick<ParameterReadCacheDeps, 'readKv' | 'writeKv'> {
  return {
    readKv: (key, version) => readParameterKvEntry(key, version),
    writeKv: (version, key, snapshot) => publishParameterKvEntry(version, key, snapshot),
  }
}
