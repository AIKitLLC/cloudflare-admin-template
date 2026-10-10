import { sql, type ScopeSql } from './scope-sql'
import type { Where } from 'payload'

/**
 * Payload `Where` has no NOT EXISTS operator. A true condition keeps the row id;
 * a false one compares it to NULL, which matches nothing.
 */
export function whereRowMatches(table: string, condition: ScopeSql): Where {
  if (!/^[a-z_]+$/.test(table)) {
    throw new Error(`Unexpected table ${table}`)
  }
  const id = sql.raw(`"${table}"."id"`)
  return {
    id: {
      equals: sql`CASE WHEN (${condition}) THEN ${id} ELSE NULL END` as unknown as number,
    },
  }
}
