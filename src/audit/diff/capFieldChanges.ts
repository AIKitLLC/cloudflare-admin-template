import { MAX_CHANGE_ROWS } from '../constants'
import type { FieldChange } from '../types'

/**
 * Keeps a bounded number of change rows. The last row records how many were omitted
 * so a wide document cannot grow the audit row without a limit.
 */
export function capFieldChanges(changes: readonly FieldChange[]): FieldChange[] {
  if (changes.length <= MAX_CHANGE_ROWS) return [...changes]
  const kept = changes.slice(0, MAX_CHANGE_ROWS - 1)
  const omitted = changes.length - kept.length
  kept.push({
    path: '_truncated',
    oldValue: null,
    newValue: `${omitted} additional fields omitted`,
  })
  return kept
}
