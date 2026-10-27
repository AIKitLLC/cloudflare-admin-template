import type { CollectionSlug, TextFieldSingleValidation } from 'payload'

/**
 * The database rejects a repeated slug, but the error it raises is not one Payload maps, so the
 * caller got a 500. This checks first and answers a normal field error instead. The unique index
 * stays as the backstop for two requests racing each other.
 */
export function uniqueSlug(collection: CollectionSlug, label: string): TextFieldSingleValidation {
  return async (value, { id, req }) => {
    if (typeof value !== 'string' || value === '') return 'This field is required.'
    const { totalDocs } = await req.payload.count({
      collection,
      // Every actor must see the clash, including one whose scope hides the other row.
      overrideAccess: true,
      req,
      where: {
        slug: { equals: value },
        ...(id === undefined ? {} : { id: { not_equals: id } }),
      },
    })
    return totalDocs === 0 ? true : `A ${label} with this slug already exists.`
  }
}
