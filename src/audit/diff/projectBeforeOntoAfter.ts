import { isPlainObject } from './isPlainObject'

/**
 * beforeChange sees the raw database row, including hidden auth fields.
 * afterChange sees the document after afterRead, which strips those fields.
 * Dropping before-only keys avoids a fake "hash changed to null" on every update.
 * A delete passes a null after document and keeps the full before snapshot.
 */
export function projectBeforeOntoAfter(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!before || !after) return before

  const projected: Record<string, unknown> = {}
  for (const key of Object.keys(before)) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) continue
    const beforeValue = before[key]
    const afterValue = after[key]
    projected[key] =
      isPlainObject(beforeValue) && isPlainObject(afterValue)
        ? projectBeforeOntoAfter(beforeValue, afterValue)
        : beforeValue
  }
  return projected
}
