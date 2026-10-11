import type { FieldChange } from '../types'

/** First occurrence of a path wins so the document diff is not overwritten. */
export function mergeFieldChanges(primary: FieldChange[], extra: FieldChange[]): FieldChange[] {
  const byPath = new Map<string, FieldChange>()
  for (const change of primary) byPath.set(change.path, change)
  for (const change of extra) {
    if (!byPath.has(change.path)) byPath.set(change.path, change)
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
}
