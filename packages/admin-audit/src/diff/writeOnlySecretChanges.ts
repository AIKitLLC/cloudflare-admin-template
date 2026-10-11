import { REDACTED_VALUE } from '../constants'
import type { AuditAction, FieldChange } from '../types'
import { asRecord } from './isPlainObject'
import type { SensitiveFieldPolicy } from './SensitiveFieldPolicy'

/**
 * Payload auth keeps `password` on the incoming `data` and stores only a hash.
 * The saved document therefore never contains the password. Record that the
 * field was submitted, and store the redaction marker instead of the secret.
 * Persisted sensitive fields (hash, salt, sessions) are left to the doc diff.
 */
export function writeOnlySecretChanges(
  data: unknown,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  action: AuditAction,
  policy: SensitiveFieldPolicy,
): FieldChange[] {
  const record = asRecord(data)
  if (!record) return []

  const changes: FieldChange[] = []
  for (const key of Object.keys(record).sort()) {
    if (!policy.isSensitive(key)) continue
    if (record[key] == null || record[key] === '') continue
    if (hasPersistedValue(before, key) || hasPersistedValue(after, key)) continue
    changes.push({
      path: key,
      oldValue: action === 'CREATE' ? null : REDACTED_VALUE,
      newValue: REDACTED_VALUE,
    })
  }
  return changes
}

function hasPersistedValue(doc: Record<string, unknown> | null, key: string): boolean {
  return doc != null && doc[key] != null && doc[key] !== ''
}
