import type { CollectionBeforeDeleteHook, CollectionSlug, PayloadRequest, Where } from 'payload'
import { APIError } from 'payload'

import { USERS_SLUG } from '../../access/constants'
import type { ScopeDimension } from '../../access/types'
import { readRowScopeBinding } from '../bindings/read-row-scope-binding'
import { BRANCHES_SLUG, DATA_CLASSES_SLUG, ORGANIZATIONS_SLUG, RECORDS_SLUG } from '../constants'
import { SCOPE_NODE_IN_USE_ERROR } from '../errors'

export const guardScopeNodeDelete: CollectionBeforeDeleteHook = async ({ collection, id, req }) => {
  const binding = readRowScopeBinding(collection?.custom)
  if (!binding?.dimension || id === undefined || id === null) {
    return
  }
  if (await scopeNodeIsReferenced(req, binding.dimension, id)) {
    throw new APIError(SCOPE_NODE_IN_USE_ERROR, 400)
  }
}

async function scopeNodeIsReferenced(
  req: PayloadRequest,
  dimension: ScopeDimension,
  id: number | string,
): Promise<boolean> {
  const totals = await Promise.all(referenceCounts(req, dimension, id))
  return totals.some((total) => total > 0)
}

function referenceCounts(
  req: PayloadRequest,
  dimension: ScopeDimension,
  id: number | string,
): Array<Promise<number>> {
  if (dimension === 'organization') {
    return [
      countWhere(req, ORGANIZATIONS_SLUG, { parent: { equals: id } }),
      countWhere(req, BRANCHES_SLUG, { organization: { equals: id } }),
      countWhere(req, RECORDS_SLUG, { organization: { equals: id } }),
      countWhere(req, USERS_SLUG, { organizations: { equals: id } }),
    ]
  }
  if (dimension === 'branch') {
    return [
      countWhere(req, BRANCHES_SLUG, { parent: { equals: id } }),
      countWhere(req, RECORDS_SLUG, { branch: { equals: id } }),
      countWhere(req, USERS_SLUG, { branches: { equals: id } }),
    ]
  }
  return [
    countWhere(req, DATA_CLASSES_SLUG, { parent: { equals: id } }),
    countWhere(req, RECORDS_SLUG, { dataClass: { equals: id } }),
    countWhere(req, USERS_SLUG, { dataClasses: { equals: id } }),
  ]
}

async function countWhere(req: PayloadRequest, collection: string, where: Where): Promise<number> {
  const result = await req.payload.count({
    collection: collection as CollectionSlug,
    overrideAccess: true,
    req,
    where,
  })
  return result.totalDocs
}
