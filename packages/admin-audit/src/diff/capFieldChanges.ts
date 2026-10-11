import { MAX_CHANGE_ROWS, REDACTED_VALUE } from '../constants'
import type { FieldChange } from '../types'

type Sensitivity = {
  isSensitive(path: string): boolean
}

/**
 * Keeps a bounded number of change rows. Redacted and other sensitive paths
 * are kept ahead of ordinary fields, so a wide diff cannot drop "password
 * submitted" to make room for `field01`. The last row records how many were omitted.
 */
export function capFieldChanges(
  changes: readonly FieldChange[],
  policy?: Sensitivity,
): FieldChange[] {
  if (changes.length <= MAX_CHANGE_ROWS) return [...changes]
  const ranked = [...changes].sort((left, right) => {
    const bySensitivity = Number(isKeptFirst(right, policy)) - Number(isKeptFirst(left, policy))
    if (bySensitivity !== 0) return bySensitivity
    return left.path.localeCompare(right.path)
  })
  const kept = ranked.slice(0, MAX_CHANGE_ROWS - 1)
  const omitted = changes.length - kept.length
  kept.push({
    path: '_truncated',
    oldValue: null,
    newValue: `${omitted} additional fields omitted`,
  })
  return kept
}

function isKeptFirst(change: FieldChange, policy: Sensitivity | undefined): boolean {
  if (change.oldValue === REDACTED_VALUE || change.newValue === REDACTED_VALUE) return true
  return policy?.isSensitive(change.path) ?? false
}
