import type { PayloadRequest } from 'payload'

type Column = { name?: string }

type TableLookup = {
  tableNameMap?: Map<string, string>
  tables?: Record<string, Record<string, Column>>
}

export function tableForCollection(req: PayloadRequest, slug: string): string {
  const db = req.payload.db as TableLookup
  const table = db.tableNameMap?.get(slug.replace(/-/g, '_'))
  return identifier(table, `table for ${slug}`)
}

export function columnForField(req: PayloadRequest, table: string, field: string): string {
  const db = req.payload.db as TableLookup
  const column = db.tables?.[table]?.[field]?.name
  return identifier(column, `column ${table}.${field}`)
}

function identifier(value: string | undefined, label: string): string {
  if (!value || !/^[a-z0-9_]+$/.test(value)) {
    throw new Error(`Unexpected ${label}`)
  }
  return value
}
