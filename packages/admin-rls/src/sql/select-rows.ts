import type { PayloadRequest } from 'payload'

import { type ScopeSql } from './scope-sql'

type RowReader = {
  all: (query: ScopeSql) => Promise<unknown>
}

export async function selectRows(
  req: PayloadRequest,
  statement: ScopeSql,
): Promise<Array<Record<string, unknown>>> {
  const drizzle = (req.payload.db as { drizzle?: RowReader }).drizzle
  if (!drizzle) {
    throw new Error('Database cannot query scope ids')
  }
  return rowsFrom(await drizzle.all(statement))
}

function rowsFrom(result: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(result)
    ? result
    : result &&
        typeof result === 'object' &&
        Array.isArray((result as { results?: unknown }).results)
      ? (result as { results: unknown[] }).results
      : []
  return list.filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object',
  )
}
