import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, Payload } from 'payload'

import type { ParameterSnapshot, ParameterValueType } from '../types'
import { isParameterValueType } from '../validation/typed-value'
import { invalidateIsolateParameterMemory } from './isolate-parameter-cache'
import { publishParameterKvEntry } from './kv-binding'
import { bumpParameterVersion } from './version-store'

type WriteRow = {
  key?: unknown
  valueType?: unknown
  value?: unknown
  sensitive?: unknown
}

export const invalidateSystemParameterCache: CollectionAfterChangeHook = async ({
  data,
  doc,
  req,
}) => {
  await commitParameterChange(req.payload, snapshotFromWrite(data as WriteRow, doc as WriteRow))
  return doc
}

export const invalidateSystemParameterCacheOnDelete: CollectionAfterDeleteHook = async ({
  doc,
  req,
}) => {
  const key = typeof doc?.key === 'string' ? doc.key : null
  await commitParameterChange(req.payload, null, key)
}

async function commitParameterChange(
  payload: Payload,
  snapshot: ParameterSnapshot | null,
  deletedKey?: string | null,
): Promise<void> {
  invalidateIsolateParameterMemory()
  try {
    const version = await bumpParameterVersion(payload)
    if (snapshot && snapshot.value !== null && snapshot.value !== undefined) {
      await publishParameterKvEntry(version, snapshot.key, snapshot)
      return
    }
    if (deletedKey) {
      await publishParameterKvEntry(version, deletedKey, null)
    }
  } catch (error) {
    payload.logger.error({
      msg: 'System parameter cache version was not updated. Other isolates reload from D1 within the maximum cache age.',
      err: error,
    })
  }
}

function snapshotFromWrite(data: WriteRow, doc: WriteRow): ParameterSnapshot | null {
  const key = typeof data.key === 'string' ? data.key : typeof doc.key === 'string' ? doc.key : null
  const valueType = isParameterValueType(data.valueType)
    ? data.valueType
    : isParameterValueType(doc.valueType)
      ? doc.valueType
      : null
  if (!key || !valueType) {
    return null
  }
  const value = 'value' in data && data.value !== undefined ? data.value : doc.value
  return {
    key,
    valueType: valueType as ParameterValueType,
    value: value as ParameterSnapshot['value'],
    sensitive: Boolean(
      data.sensitive !== undefined && data.sensitive !== null ? data.sensitive : doc.sensitive,
    ),
  }
}
