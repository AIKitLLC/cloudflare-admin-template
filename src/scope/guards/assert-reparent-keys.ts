import type { PayloadRequest } from 'payload'
import { APIError } from 'payload'

import type { ScopeDimension } from '../../access/types'
import { relationIds } from '../../access/relation-id'
import { MAX_SCOPE_DEPTH } from '../constants'
import { SCOPE_REPARENT_KEYS_ERROR, SCOPE_TARGET_KEYS_ERROR } from '../errors'
import { findEveryPage } from '../find/find-every-page'
import { toPayloadIds } from '../ids/id-set'
import type { ScopeCatalog } from '../types'
import { parentMap } from '../tree/scope-tree'
import { assertTargetKeysWithinActor } from './assert-target-keys-within-actor'

type Holder = {
  id: number | string
  roles?: unknown
}

/**
 * Moving N under P grants N to everyone assigned at P or above P.
 * Those users must already hold only keys the actor holds.
 */
export async function assertReparentKeys(args: {
  catalog: ScopeCatalog
  dimension: ScopeDimension
  nextParentId: string | undefined
  nodeId: string | undefined
  oldParentId: string | undefined
  parentProvided: boolean
  req: PayloadRequest
}): Promise<void> {
  if (!args.parentProvided || args.nextParentId === args.oldParentId) {
    return
  }
  const parents = parentMap(nodesFor(args.catalog, args.dimension))
  const gaining = gainingAncestorIds(parents, args.oldParentId, args.nextParentId)
  if (gaining.size === 0) {
    return
  }
  const already = ancestorIds(parents, args.oldParentId)
  if (args.nodeId) {
    already.add(args.nodeId)
  }
  const holders = await findEveryPage<Holder>(
    args.req,
    'users',
    holderWhere(args.dimension, gaining),
  )
  for (const holder of holders) {
    if (alreadyHadNode(holder, args.dimension, already)) {
      continue
    }
    try {
      await assertTargetKeysWithinActor(args.req, relationIds(holder.roles))
    } catch (error) {
      if (error instanceof APIError && error.message === SCOPE_TARGET_KEYS_ERROR) {
        throw new APIError(SCOPE_REPARENT_KEYS_ERROR, 403)
      }
      throw error
    }
  }
}

function gainingAncestorIds(
  parents: ReadonlyMap<string, string | undefined>,
  oldParentId: string | undefined,
  nextParentId: string | undefined,
): Set<string> {
  const previous = ancestorIds(parents, oldParentId)
  const next = ancestorIds(parents, nextParentId)
  const gaining = new Set<string>()
  for (const id of next) {
    if (!previous.has(id)) {
      gaining.add(id)
    }
  }
  return gaining
}

function alreadyHadNode(
  holder: Holder,
  dimension: ScopeDimension,
  already: ReadonlySet<string>,
): boolean {
  const field =
    dimension === 'organization'
      ? 'organizations'
      : dimension === 'branch'
        ? 'branches'
        : 'dataClasses'
  return relationIds((holder as Record<string, unknown>)[field]).some((id) => already.has(id))
}

function ancestorIds(
  parents: ReadonlyMap<string, string | undefined>,
  start: string | undefined,
): Set<string> {
  const ids = new Set<string>()
  let current = start
  let depth = 0
  while (current && depth < MAX_SCOPE_DEPTH && !ids.has(current)) {
    ids.add(current)
    depth += 1
    current = parents.get(current)
  }
  return ids
}

function nodesFor(catalog: ScopeCatalog, dimension: ScopeDimension) {
  if (dimension === 'organization') {
    return catalog.organizations
  }
  if (dimension === 'branch') {
    return catalog.branches
  }
  return catalog.dataClasses
}

function holderWhere(dimension: ScopeDimension, ids: ReadonlySet<string>) {
  const list = toPayloadIds(ids)
  if (dimension === 'organization') {
    return { organizations: { in: list } }
  }
  if (dimension === 'branch') {
    return { branches: { in: list } }
  }
  return { dataClasses: { in: list } }
}
