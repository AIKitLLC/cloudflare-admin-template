import { IGNORED_DIFF_PATHS, REDACTED_VALUE } from '../constants'
import type { FieldChange } from '../types'
import { boundLoggedValue } from './boundLoggedValue'
import { isPlainObject } from './isPlainObject'
import { redactValue } from './redactValue'
import type { SensitiveFieldPolicy } from './SensitiveFieldPolicy'
import { valuesEqual } from './stableValue'

/**
 * Column-level diff. Objects are walked into dotted paths.
 * Arrays are compared as one value so order changes stay visible.
 * Sensitive paths are recorded only as a redaction marker.
 */
export function computeFieldDiff(
  before: unknown,
  after: unknown,
  policy: SensitiveFieldPolicy,
): FieldChange[] {
  const changes: FieldChange[] = []
  walk('', before, after, policy, changes, 0)
  return changes.sort((left, right) => left.path.localeCompare(right.path))
}

const MAX_DEPTH = 20

function walk(
  path: string,
  before: unknown,
  after: unknown,
  policy: SensitiveFieldPolicy,
  changes: FieldChange[],
  depth: number,
): void {
  if (path && IGNORED_DIFF_PATHS.has(path)) return

  if (depth > MAX_DEPTH) {
    if (path && !valuesEqual(before, after)) changes.push(toChange(path, before, after, policy))
    return
  }

  if (path && policy.isSensitive(path)) {
    if (!valuesEqual(before, after)) {
      changes.push(toChange(path, before, after, policy))
    }
    return
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    walkKeys(path, before, after, policy, changes, depth)
    return
  }

  if (isPlainObject(after) && before == null) {
    walkKeys(path, {}, after, policy, changes, depth)
    return
  }

  if (isPlainObject(before) && after == null) {
    walkKeys(path, before, {}, policy, changes, depth)
    return
  }

  if (!path || valuesEqual(before, after)) return
  changes.push(toChange(path, before, after, policy))
}

function walkKeys(
  path: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  policy: SensitiveFieldPolicy,
  changes: FieldChange[],
  depth: number,
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of [...keys].sort()) {
    const nextPath = path ? `${path}.${key}` : key
    walk(nextPath, before[key], after[key], policy, changes, depth + 1)
  }
}

function toChange(
  path: string,
  before: unknown,
  after: unknown,
  policy: SensitiveFieldPolicy,
): FieldChange {
  const sensitive = policy.isSensitive(path)
  return {
    path,
    oldValue: boundLoggedValue(sensitive ? marker(before) : redactValue(path, before ?? null, policy)),
    newValue: boundLoggedValue(sensitive ? marker(after) : redactValue(path, after ?? null, policy)),
  }
}

function marker(value: unknown): string | null {
  return value == null ? null : REDACTED_VALUE
}
