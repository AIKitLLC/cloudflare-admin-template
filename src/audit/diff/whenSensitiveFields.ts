import { isPlainObject } from './isPlainObject'

const WHEN_SENSITIVE = 'whenSensitive'

type FieldLike = {
  name?: string
  custom?: { audit?: { redact?: unknown } }
  fields?: readonly FieldLike[]
  blocks?: readonly { fields?: readonly FieldLike[] }[]
  tabs?: readonly { name?: string; fields?: readonly FieldLike[] }[]
}

/**
 * Field paths whose `custom.audit.redact` is `whenSensitive`, included only
 * while one of the documents has `sensitive: true`. Audit does not import the
 * system-parameters package. The flag is the contract.
 */
export function whenSensitiveFieldNames(
  fields: readonly FieldLike[] | undefined,
  documents: readonly unknown[],
): string[] {
  if (!documents.some(isSensitiveDocument)) return []
  const names: string[] = []
  collect(fields, '', names)
  return names
}

function isSensitiveDocument(value: unknown): boolean {
  return isPlainObject(value) && value.sensitive === true
}

function collect(fields: readonly FieldLike[] | undefined, prefix: string, names: string[]): void {
  if (!fields) return
  for (const field of fields) {
    const path = field.name ? (prefix ? `${prefix}.${field.name}` : field.name) : prefix
    if (field.name && field.custom?.audit?.redact === WHEN_SENSITIVE) {
      names.push(path)
    }
    collect(field.fields, field.name ? path : prefix, names)
    for (const block of field.blocks ?? []) collect(block.fields, path, names)
    for (const tab of field.tabs ?? []) {
      const tabPath = tab.name ? (path ? `${path}.${tab.name}` : tab.name) : path
      collect(tab.fields, tabPath, names)
    }
  }
}
