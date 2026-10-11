import { isPlainObject } from './isPlainObject'

type FieldLike = {
  name?: string
  type: string
  hasMany?: boolean
  relationTo?: string | readonly string[]
  fields?: readonly FieldLike[]
  blocks?: readonly { slug?: string; fields?: readonly FieldLike[] }[]
  tabs?: readonly { name?: string; fields?: readonly FieldLike[] }[]
}

/**
 * Collapses relationship and upload values to ids before a diff.
 * `previousDoc` is often a bare id while `doc` is populated at request depth.
 * Comparing those shapes logs a phantom change and stores the related document.
 */
export function normalizeRelations(value: unknown, fields: readonly FieldLike[] | undefined): unknown {
  if (!fields || !isPlainObject(value)) return value
  const copy: Record<string, unknown> = { ...value }
  for (const field of fields) {
    if (!field.name) {
      if (field.type === 'tabs' || field.type === 'row' || field.type === 'collapsible') {
        Object.assign(copy, normalizeField(copy, field) as Record<string, unknown>)
      }
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(copy, field.name)) continue
    copy[field.name] = normalizeField(copy[field.name], field)
  }
  return copy
}

function normalizeField(value: unknown, field: FieldLike): unknown {
  if (field.type === 'relationship' || field.type === 'upload') {
    return normalizeRelation(value, field)
  }
  if (field.type === 'array' && Array.isArray(value)) {
    return value.map((row) => normalizeRelations(row, field.fields))
  }
  if ((field.type === 'group' || field.type === 'collapsible' || field.type === 'row') && isPlainObject(value)) {
    return normalizeRelations(value, field.fields)
  }
  if (field.type === 'tabs' && isPlainObject(value)) {
    const copy: Record<string, unknown> = { ...value }
    for (const tab of field.tabs ?? []) {
      if (tab.name && isPlainObject(copy[tab.name])) {
        copy[tab.name] = normalizeRelations(copy[tab.name], tab.fields)
      } else {
        Object.assign(copy, normalizeRelations(copy, tab.fields) as Record<string, unknown>)
      }
    }
    return copy
  }
  if (field.type === 'blocks' && Array.isArray(value)) {
    return value.map((row) => normalizeBlock(row, field.blocks))
  }
  return value
}

function normalizeRelation(value: unknown, field: FieldLike): unknown {
  const polymorphic = Array.isArray(field.relationTo)
  if (field.hasMany && Array.isArray(value)) {
    return value.map((item) => normalizeOneRelation(item, polymorphic))
  }
  return normalizeOneRelation(value, polymorphic)
}

function normalizeOneRelation(value: unknown, polymorphic: boolean): unknown {
  if (value == null) return value
  if (polymorphic && isPlainObject(value) && 'relationTo' in value) {
    return {
      relationTo: value.relationTo,
      value: relationId(value.value),
    }
  }
  return relationId(value)
}

function relationId(value: unknown): unknown {
  if (isPlainObject(value) && 'id' in value && !('relationTo' in value)) return value.id
  return value
}

function normalizeBlock(
  row: unknown,
  blocks: readonly { slug?: string; fields?: readonly FieldLike[] }[] | undefined,
): unknown {
  if (!isPlainObject(row)) return row
  const blockType = row.blockType
  const block = blocks?.find((candidate) => candidate.slug === blockType)
  return normalizeRelations(row, block?.fields)
}
