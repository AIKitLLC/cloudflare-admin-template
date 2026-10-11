import { REDACTED_VALUE } from '../constants'
import type { AuditAction, FieldChange } from '../types'
import { asRecord } from './isPlainObject'
import type { SensitiveFieldPolicy } from './SensitiveFieldPolicy'
import { valuesEqual } from './stableValue'

/**
 * Field names only. The secret itself is never copied.
 * A secret already stored on the document is included only when the submitted
 * value differs, so an unchanged hash merged into `data` is not a new event.
 */
export function submittedSecretPaths(
  data: unknown,
  originalDoc: unknown,
  policy: SensitiveFieldPolicy,
): string[] {
  const record = asRecord(data)
  if (!record) return []
  const original = asRecord(originalDoc)
  return Object.keys(record)
    .filter((key) => {
      if (!policy.isSensitive(key)) return false
      if (record[key] == null || record[key] === '') return false
      if (!original || !Object.prototype.hasOwnProperty.call(original, key)) return true
      return !valuesEqual(original[key], record[key])
    })
    .sort()
}

export function changesForSubmittedSecrets(
  paths: readonly string[],
  action: AuditAction,
): FieldChange[] {
  return paths.map((path) => ({
    path,
    oldValue: action === 'CREATE' ? null : REDACTED_VALUE,
    newValue: REDACTED_VALUE,
  }))
}
