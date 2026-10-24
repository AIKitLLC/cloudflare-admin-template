import { relationIds } from '../../access'

export function idSet(value: unknown): Set<string> {
  return new Set(relationIds(value))
}

export function sameIdSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const id of left) {
    if (!right.has(id)) {
      return false
    }
  }
  return true
}

export function isIdSubset(subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  for (const id of subset) {
    if (!superset.has(id)) {
      return false
    }
  }
  return true
}

export function toPayloadIds(ids: Iterable<string>): Array<number | string> {
  const values: Array<number | string> = []
  for (const id of ids) {
    values.push(/^\d+$/.test(id) ? Number(id) : id)
  }
  return values
}
