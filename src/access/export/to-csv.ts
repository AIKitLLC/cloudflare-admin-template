const FORMULA_PREFIX = /^[=+\-@]/

export function toCsv(rows: Record<string, unknown>[]): string {
  const columns = collectColumns(rows)
  const header = columns.map(escapeCell).join(',')
  const body = rows.map((row) =>
    columns.map((column) => escapeCell(formatCell(row[column]))).join(','),
  )
  return [header, ...body].join('\n')
}

function collectColumns(rows: Record<string, unknown>[]): string[] {
  const columns = new Set<string>()
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columns.add(key)
    }
  }
  return [...columns].sort((left, right) => {
    if (left === 'id') return -1
    if (right === 'id') return 1
    return left.localeCompare(right)
  })
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value)
}

function escapeCell(value: string): string {
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replaceAll('"', '""')}"`
  }
  return safe
}
