import type { CollectionBeforeDeleteHook, CollectionSlug, PayloadRequest, Where } from 'payload'
import { APIError } from 'payload'

import type { RowScopeBinding, ScopeDimension } from '../../access'
import { readRowScopeBinding } from '../bindings/read-row-scope-binding'
import {
  BRANCH_ORGANIZATION_FIELD,
  BRANCHES_SLUG,
  SCOPE_PARENT_FIELD,
  USER_BRANCHES_FIELD,
  USER_DATA_CLASSES_FIELD,
  USER_ORGANIZATIONS_FIELD,
} from '../constants'
import { SCOPE_NODE_IN_USE_ERROR } from '../errors'

export const guardScopeNodeDelete: CollectionBeforeDeleteHook = async ({ collection, id, req }) => {
  const binding = readRowScopeBinding(collection?.custom)
  if (!binding?.dimension || id === undefined || id === null) {
    return
  }
  if (await scopeNodeIsReferenced(req, binding.dimension, collection.slug, id)) {
    throw new APIError(SCOPE_NODE_IN_USE_ERROR, 400)
  }
}

async function scopeNodeIsReferenced(
  req: PayloadRequest,
  dimension: ScopeDimension,
  slug: string,
  id: number | string,
): Promise<boolean> {
  const totals = await Promise.all(referenceCounts(req, dimension, slug, id))
  return totals.some((total) => total > 0)
}

/**
 * Child links and branch organization links are structural.
 * Record and user references come from each collection's rowScope config.
 *
 * The counts run, then Payload deletes. Two overlapping deletes can both observe zero
 * references and both proceed. That is the same check-then-write window as the last
 * full-access holder. A later request that still points at the removed node is hidden
 * from limited readers because the foreign key clears the relationship.
 */
function referenceCounts(
  req: PayloadRequest,
  dimension: ScopeDimension,
  slug: string,
  id: number | string,
): Array<Promise<number>> {
  const counts: Array<Promise<number>> = [
    countWhere(req, slug, { [SCOPE_PARENT_FIELD]: { equals: id } }),
  ]
  if (dimension === 'organization') {
    counts.push(countWhere(req, BRANCHES_SLUG, { [BRANCH_ORGANIZATION_FIELD]: { equals: id } }))
  }
  for (const collection of Object.values(req.payload.collections)) {
    const binding = readRowScopeBinding(collection.config.custom)
    if (!binding) {
      continue
    }
    const field = referenceField(binding, dimension)
    if (field) {
      counts.push(countWhere(req, collection.config.slug, { [field]: { equals: id } }))
    }
    if (binding.assignments) {
      counts.push(
        countWhere(req, collection.config.slug, {
          [assignmentField(dimension)]: { equals: id },
        }),
      )
    }
  }
  return counts
}

function referenceField(binding: RowScopeBinding, dimension: ScopeDimension): string | undefined {
  if (dimension === 'organization') {
    return binding.organizationField
  }
  if (dimension === 'branch') {
    return binding.branchField
  }
  return binding.dataClassField
}

function assignmentField(dimension: ScopeDimension): string {
  if (dimension === 'organization') {
    return USER_ORGANIZATIONS_FIELD
  }
  if (dimension === 'branch') {
    return USER_BRANCHES_FIELD
  }
  return USER_DATA_CLASSES_FIELD
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
