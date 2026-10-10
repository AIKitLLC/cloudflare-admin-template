import { isPlainObject } from './isPlainObject'

export function normalizeEmpty(value: unknown): unknown {
  return value === undefined ? null : value
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(normalizeEmpty(value)))
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isPlainObject(value)) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys(value[key])
  }
  return sorted
}
