import type { Payload } from 'payload'

import { PARAMETER_VERSION_STATE_KEY } from '../constants'
import type { VersionStore } from '../types'

type D1Statement = {
  bind: (...values: unknown[]) => D1Statement
  first: <T>() => Promise<T | null>
  run: () => Promise<unknown>
}

type D1DatabaseLike = {
  prepare: (query: string) => D1Statement
}

const BUMP_VERSION = `
INSERT INTO payload_kv (\`key\`, \`data\`)
VALUES (?, '{"version":1}')
ON CONFLICT(\`key\`) DO UPDATE SET
  \`data\` = json_set(\`data\`, '$.version', COALESCE(json_extract(\`data\`, '$.version'), 0) + 1)
RETURNING json_extract(\`data\`, '$.version') AS version
`

const READ_VERSION = `
SELECT json_extract(\`data\`, '$.version') AS version
FROM payload_kv
WHERE \`key\` = ?
`

export function createPayloadVersionStore(payload: Payload): VersionStore {
  return {
    readVersion: () => readParameterVersion(payload),
    bumpVersion: () => bumpParameterVersion(payload),
  }
}

export async function readParameterVersion(payload: Payload): Promise<number> {
  const row = await d1(payload).prepare(READ_VERSION).bind(PARAMETER_VERSION_STATE_KEY).first<{
    version?: number | string | null
  }>()
  return coerceVersion(row?.version)
}

export async function bumpParameterVersion(payload: Payload): Promise<number> {
  const row = await d1(payload).prepare(BUMP_VERSION).bind(PARAMETER_VERSION_STATE_KEY).first<{
    version?: number | string | null
  }>()
  const version = coerceVersion(row?.version)
  if (version < 1) {
    throw new Error('System parameter cache version was not incremented.')
  }
  return version
}

function d1(payload: Payload): D1DatabaseLike {
  const client = (payload.db as { client?: D1DatabaseLike }).client
  if (!client) {
    throw new Error('D1 client is unavailable.')
  }
  return client
}

function coerceVersion(value: number | string | null | undefined): number {
  const version = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(version) || version < 0) {
    return 0
  }
  return version
}
