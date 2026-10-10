import type { CollectionBeforeChangeHook, PayloadRequest } from 'payload'
import { APIError } from 'payload'

import type { ScopeDimension } from '../../access/types'
import { userGrantsFullAccess } from '../../access/resolve/load-user-grants'
import { relationId } from '../../access/relation-id'
import { skipsPrivilegeChecks } from '../../rbac/guards/privilege-context'
import { readRowScopeBinding } from '../bindings/read-row-scope-binding'
import { SCOPE_BRANCH_ORG_ERROR, SCOPE_NODE_ERROR } from '../errors'
import { SKIP_SCOPE_PATH_CONTEXT } from '../constants'
import { assertReparentKeys } from './assert-reparent-keys'
import { loadEffectiveScope } from '../resolve/load-effective-scope'
import { loadScopeCatalog } from '../resolve/load-scope-catalog'
import type { EffectiveScope, ScopeCatalog } from '../types'
import { parentMap, ScopeTree } from '../tree/scope-tree'

export const guardScopeNode: CollectionBeforeChangeHook = async ({
  collection,
  context,
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (
    context?.[SKIP_SCOPE_PATH_CONTEXT] === true ||
    req.context?.[SKIP_SCOPE_PATH_CONTEXT] === true
  ) {
    return data
  }
  if (!data) {
    return data
  }
  const binding = readRowScopeBinding(collection?.custom)
  if (!binding?.dimension) {
    return data
  }

  const record = data as Record<string, unknown>
  const original = originalDoc as Record<string, unknown> | undefined
  const parentProvided = record.parent !== undefined
  const nextParentId = parentProvided ? relationId(record.parent) : relationId(original?.parent)
  const nodeId = relationId(original?.id)

  if (nextParentId || parentProvided) {
    const catalog = await loadScopeCatalog(req)
    treeFor(binding.dimension, catalog).assertParentDoesNotCycle(nodeId, nextParentId)
  }

  if (skipsPrivilegeChecks(req.context) || !req.user || (await userGrantsFullAccess(req))) {
    return data
  }

  const [scope, catalog] = await Promise.all([loadEffectiveScope(req), loadScopeCatalog(req)])
  if (binding.dimension === 'branch') {
    await assertBranchWrite({
      catalog,
      nextParentId,
      nodeId,
      operation,
      original,
      parentProvided,
      record,
      req,
      scope,
    })
    return data
  }

  assertTreeWrite({
    allowed: allowedIds(scope, binding.dimension),
    nextParentId,
    nodeId,
    operation,
    parentProvided,
  })
  if (operation === 'update') {
    await assertReparentKeys({
      catalog,
      dimension: binding.dimension,
      nextParentId,
      nodeId,
      oldParentId: relationId(original?.parent),
      parentProvided,
      req,
    })
  }
  return data
}

function assertTreeWrite(args: {
  allowed: ReadonlySet<string>
  nextParentId: string | undefined
  nodeId: string | undefined
  operation: 'create' | 'update'
  parentProvided: boolean
}): void {
  if (args.operation === 'create') {
    if (!args.nextParentId || !args.allowed.has(args.nextParentId)) {
      throw new APIError(SCOPE_NODE_ERROR, 403)
    }
    return
  }
  if (!args.nodeId || !args.allowed.has(args.nodeId)) {
    throw new APIError(SCOPE_NODE_ERROR, 403)
  }
  if (args.parentProvided && (!args.nextParentId || !args.allowed.has(args.nextParentId))) {
    throw new APIError(SCOPE_NODE_ERROR, 403)
  }
}

async function assertBranchWrite(args: {
  catalog: ScopeCatalog
  nextParentId: string | undefined
  nodeId: string | undefined
  operation: 'create' | 'update'
  original: Record<string, unknown> | undefined
  parentProvided: boolean
  record: Record<string, unknown>
  req: PayloadRequest
  scope: EffectiveScope
}): Promise<void> {
  assertTreeWrite({
    allowed: args.scope.branchIds,
    nextParentId: args.nextParentId,
    nodeId: args.nodeId,
    operation: args.operation,
    parentProvided: args.parentProvided,
  })
  const organizationId =
    args.operation === 'create'
      ? relationId(args.record.organization)
      : relationId(
          args.record.organization === undefined
            ? args.original?.organization
            : args.record.organization,
        )
  const originalOrganizationId = relationId(args.original?.organization)
  if (
    args.operation === 'update' &&
    args.record.organization !== undefined &&
    organizationId !== originalOrganizationId
  ) {
    throw new APIError(SCOPE_BRANCH_ORG_ERROR, 403)
  }
  if (args.operation === 'update') {
    await assertReparentKeys({
      catalog: args.catalog,
      dimension: 'branch',
      nextParentId: args.nextParentId,
      nodeId: args.nodeId,
      oldParentId: relationId(args.original?.parent),
      parentProvided: args.parentProvided,
      req: args.req,
    })
  }
  if (!args.nextParentId) {
    return
  }
  const parentOrganizationId = args.catalog.branches.get(args.nextParentId)?.organizationId
  if (!organizationId || !parentOrganizationId || organizationId !== parentOrganizationId) {
    throw new APIError(SCOPE_BRANCH_ORG_ERROR, 400)
  }
}

function allowedIds(scope: EffectiveScope, dimension: ScopeDimension): ReadonlySet<string> {
  if (dimension === 'organization') {
    return scope.grantableOrganizationIds
  }
  if (dimension === 'branch') {
    return scope.branchIds
  }
  return scope.dataClassIds
}

function treeFor(dimension: ScopeDimension, catalog: ScopeCatalog): ScopeTree {
  if (dimension === 'organization') {
    return new ScopeTree(parentMap(catalog.organizations))
  }
  if (dimension === 'branch') {
    return new ScopeTree(parentMap(catalog.branches))
  }
  return new ScopeTree(parentMap(catalog.dataClasses))
}
