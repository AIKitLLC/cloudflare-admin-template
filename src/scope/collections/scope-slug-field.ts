import type { CollectionSlug, TextField, TextFieldSingleValidation } from 'payload'

/**
 * Unique slug for a scope node. The column is `unique`, but D1 does not report the violation
 * with the `SQLITE_CONSTRAINT_UNIQUE` code Payload maps to a field error, so a duplicate would
 * answer 500. The check runs across the whole collection (not the caller's scope): uniqueness is
 * global. The column constraint still covers two concurrent writes.
 */
export function scopeSlugField(): TextField {
  return {
    name: 'slug',
    type: 'text',
    required: true,
    unique: true,
    index: true,
    validate: uniqueSlug,
  }
}

const uniqueSlug: TextFieldSingleValidation = async (value, { collectionSlug, id, req }) => {
  if (typeof value !== 'string' || value.length === 0) return req.t('validation:required')
  const { totalDocs } = await req.payload.count({
    collection: collectionSlug as CollectionSlug,
    where: {
      slug: { equals: value },
      ...(id === undefined ? {} : { id: { not_equals: id } }),
    },
    overrideAccess: true,
  })
  return totalDocs === 0 ? true : req.t('error:valueMustBeUnique')
}
