import { describe, expect, it } from 'vitest'

import {
  createIsolateMemory,
  ParameterReadCache,
} from '@/system-parameters/cache/parameter-read-cache'
import { readOptionalParameterKv, snapshotFromKvEntry } from '@/system-parameters/cache/kv-binding'
import type { ParameterSnapshot, VersionStore } from '@/system-parameters/types'

const VERIFY_TTL_MS = 2_000
const MAX_AGE_MS = 30_000

function snapshot(value: string, key = 'maintenance-mode'): ParameterSnapshot {
  return { key, valueType: 'string', value, sensitive: false }
}

function memoryVersionStore(initial = 1): VersionStore & { version: number } {
  return {
    version: initial,
    readVersion: async function readVersion() {
      return this.version
    },
    bumpVersion: async function bumpVersion() {
      this.version += 1
      return this.version
    },
  }
}

function cacheFor(args: {
  versions: VersionStore
  load: (key: string) => Promise<ParameterSnapshot | null>
  now: () => number
  readKv?: (key: string, version: number) => Promise<ParameterSnapshot | null | undefined>
  writeKv?: (version: number, key: string, snapshot: ParameterSnapshot | null) => Promise<void>
}): ParameterReadCache {
  return new ParameterReadCache({
    memory: createIsolateMemory(),
    versions: args.versions,
    load: args.load,
    readKv: args.readKv ?? (async () => undefined),
    writeKv: args.writeKv ?? (async () => undefined),
    now: args.now,
    verifyTtlMs: VERIFY_TTL_MS,
    maxAgeMs: MAX_AGE_MS,
  })
}

describe('system parameter isolate cache', () => {
  it('serves another isolate the new value only after the verify window and a version bump', async () => {
    const versions = memoryVersionStore(1)
    let stored = snapshot('off')
    const load = async () => stored
    const clock = { now: 10_000 }
    const writer = cacheFor({ versions, load, now: () => clock.now })
    const reader = cacheFor({ versions, load, now: () => clock.now })

    expect((await writer.read('maintenance-mode'))?.value).toBe('off')
    expect((await reader.read('maintenance-mode'))?.value).toBe('off')

    stored = snapshot('on')
    versions.version = 2
    writer.invalidate()

    expect((await writer.read('maintenance-mode'))?.value).toBe('on')
    clock.now += 500
    expect((await reader.read('maintenance-mode'))?.value).toBe('off')
    clock.now += VERIFY_TTL_MS
    expect((await reader.read('maintenance-mode'))?.value).toBe('on')
  })

  it('reloads from D1 when the maximum age passes even if the version did not change', async () => {
    const versions = memoryVersionStore(4)
    let stored = snapshot('stale')
    let loads = 0
    const clock = { now: 0 }
    const cache = cacheFor({
      versions,
      load: async () => {
        loads += 1
        return stored
      },
      now: () => clock.now,
    })

    await cache.read('maintenance-mode')
    clock.now = 1_000
    await cache.read('maintenance-mode')
    expect(loads).toBe(1)

    stored = snapshot('fresh')
    clock.now = MAX_AGE_MS + 1
    expect((await cache.read('maintenance-mode'))?.value).toBe('fresh')
    expect(loads).toBe(2)
  })

  it('uses a KV entry only when its version matches D1 and otherwise falls back', async () => {
    const versions = memoryVersionStore(3)
    let loads = 0
    const kv = new Map<string, string>()
    const cache = cacheFor({
      versions,
      load: async () => {
        loads += 1
        return snapshot('from-d1')
      },
      now: () => 50_000,
      readKv: async (key, version) => {
        const raw = kv.get(key)
        if (!raw) return undefined
        return snapshotFromKvEntry(JSON.parse(raw), version)
      },
      writeKv: async (version, key, value) => {
        kv.set(key, JSON.stringify({ version, found: value !== null, snapshot: value }))
      },
    })

    kv.set(
      'maintenance-mode',
      JSON.stringify({ version: 3, found: true, snapshot: snapshot('from-kv') }),
    )
    expect((await cache.read('maintenance-mode'))?.value).toBe('from-kv')
    expect(loads).toBe(0)

    const cold = cacheFor({
      versions: memoryVersionStore(4),
      load: async () => {
        loads += 1
        return snapshot('from-d1')
      },
      now: () => 50_000,
      readKv: async (key, version) =>
        snapshotFromKvEntry(JSON.parse(kv.get(key) ?? 'null'), version),
    })
    expect((await cold.read('maintenance-mode'))?.value).toBe('from-d1')
    expect(loads).toBe(1)
  })

  it('reads no KV binding when the Cloudflare context does not provide one', () => {
    expect(readOptionalParameterKv()).toBeNull()
  })
})
