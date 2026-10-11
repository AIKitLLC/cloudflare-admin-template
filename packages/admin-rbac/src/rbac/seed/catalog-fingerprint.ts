import type { PermissionDefinition } from '../catalog/permission-definition'

export function catalogFingerprint(definitions: PermissionDefinition[]): string {
  const lines = definitions
    .map((definition) =>
      [
        definition.key,
        definition.label,
        definition.collectionSlug,
        definition.action,
        definition.fieldPath ?? '',
      ].join('\t'),
    )
    .sort()
  return hashText(lines.join('\n'))
}

function hashText(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}
