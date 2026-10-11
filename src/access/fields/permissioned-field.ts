import { SYSTEM_FIELD_NAMES } from '../constants'

export type WalkableField = {
  name?: string
  type: string
  hidden?: boolean
  label?: unknown
  fields?: WalkableField[]
  tabs?: { name?: string; fields?: WalkableField[] }[]
  blocks?: ({ slug?: string; fields?: WalkableField[] } | string)[]
  access?: {
    create?: unknown
    read?: unknown
    update?: unknown
    rbacApplied?: boolean
  }
}

export function fieldHasBuiltinAccess(field: WalkableField): boolean {
  if (field.access?.rbacApplied) {
    return false
  }
  return Boolean(field.access?.create || field.access?.read || field.access?.update)
}

export function isPermissionedField(field: WalkableField): boolean {
  if (!field.name || field.type === 'ui' || field.hidden) {
    return false
  }
  if (SYSTEM_FIELD_NAMES.has(field.name)) {
    return false
  }
  if (fieldHasBuiltinAccess(field)) {
    return false
  }
  return true
}

export function fieldDisplayLabel(field: WalkableField): string {
  if (typeof field.label === 'string' && field.label.trim()) {
    return field.label
  }
  return field.name ?? 'Field'
}

export function walkPermissionedFields(
  fields: WalkableField[],
  visit: (field: WalkableField, fieldPath: string) => void,
  prefix = '',
): void {
  for (const field of fields) {
    if (field.type === 'tabs' && field.tabs) {
      for (const tab of field.tabs) {
        const tabPrefix = tab.name ? joinPath(prefix, tab.name) : prefix
        walkPermissionedFields(tab.fields ?? [], visit, tabPrefix)
      }
      continue
    }

    if ((field.type === 'row' || field.type === 'collapsible') && field.fields) {
      walkPermissionedFields(field.fields, visit, prefix)
      continue
    }

    if (!field.name || field.type === 'ui' || field.hidden) {
      continue
    }

    if (SYSTEM_FIELD_NAMES.has(field.name) && !prefix) {
      continue
    }

    if (fieldHasBuiltinAccess(field)) {
      continue
    }

    const fieldPath = joinPath(prefix, field.name)
    visit(field, fieldPath)

    if ((field.type === 'group' || field.type === 'array') && field.fields) {
      walkPermissionedFields(field.fields, visit, fieldPath)
    }

    if (field.type === 'blocks' && field.blocks) {
      for (const block of field.blocks) {
        if (typeof block === 'string' || !block.fields || !block.slug) {
          continue
        }
        walkPermissionedFields(block.fields, visit, `${fieldPath}.${block.slug}`)
      }
    }
  }
}

function joinPath(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name
}
