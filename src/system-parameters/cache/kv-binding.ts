import { SYSTEM_PARAMETERS_KV_BINDING } from '../constants'
import type { ParameterKv, ParameterSnapshot } from '../types'
import { isParameterValueType } from '../validation/typed-value'

const CLOUDFLARE_CONTEXT = Symbol.for('__cloudflare-context__')

type KvEntry = {
  version: number
  found: boolean
  snapshot?: ParameterSnapshot
}

export function parameterKvKey(key: string): string {
  return `parameter:${key}`
}

export function readOptionalParameterKv(): ParameterKv | null {
  const holder = globalThis as typeof globalThis & Record<symbol, { env?: Record<string, unknown> }>
  const binding = holder[CLOUDFLARE_CONTEXT]?.env?.[SYSTEM_PARAMETERS_KV_BINDING]
  if (!isParameterKv(binding)) {
    return null
  }
  return binding
}

export async function publishParameterKvEntry(
  version: number,
  key: string,
  snapshot: ParameterSnapshot | null,
): Promise<void> {
  const kv = readOptionalParameterKv()
  if (!kv) {
    return
  }
  try {
    if (!snapshot) {
      await kv.delete(parameterKvKey(key))
      return
    }
    const entry: KvEntry = { version, found: true, snapshot }
    await kv.put(parameterKvKey(key), JSON.stringify(entry))
  } catch {
    return
  }
}

export async function readParameterKvEntry(
  key: string,
  version: number,
): Promise<ParameterSnapshot | null | undefined> {
  const kv = readOptionalParameterKv()
  if (!kv) {
    return undefined
  }
  try {
    const raw = await kv.get(parameterKvKey(key))
    if (!raw) {
      return undefined
    }
    return snapshotFromKvEntry(JSON.parse(raw) as KvEntry, version)
  } catch {
    return undefined
  }
}

export function snapshotFromKvEntry(
  entry: KvEntry,
  version: number,
): ParameterSnapshot | null | undefined {
  if (!entry || entry.version !== version) {
    return undefined
  }
  if (!entry.found) {
    return null
  }
  const snapshot = entry.snapshot
  if (!snapshot || snapshot.key.length === 0 || !isParameterValueType(snapshot.valueType)) {
    return undefined
  }
  return snapshot
}

function isParameterKv(value: unknown): value is ParameterKv {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<ParameterKv>
  return (
    typeof candidate.get === 'function' &&
    typeof candidate.put === 'function' &&
    typeof candidate.delete === 'function'
  )
}
