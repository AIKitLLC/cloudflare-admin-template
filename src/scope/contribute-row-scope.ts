import type { Where } from 'payload'

import type { AccessEvaluationContext } from '../access/types'
import { bindingFiltersRows } from './bindings/read-row-scope-binding'
import { D1_SAFE_PAGE_SIZE } from './constants'
import { loadScopeAssignments } from './resolve/load-scope-assignments'
import { loadScopeCatalog } from './resolve/load-scope-catalog'
import { parentMap } from './tree/scope-tree'
import { whereBindingIds } from './where/where-binding-sql'
import type { DirectScope } from './where/direct-scope'
import { collapseCoveredIds } from './where/collapse-covered-ids'
import { estimatedScopeBinds, whereForBinding } from './where/where-for-binding'
import { whereUsersWithinScope } from './where/where-users-within-scope'

export async function contributeRowScope(
  context: AccessEvaluationContext,
): Promise<Where | undefined> {
  if (context.action === 'create' || context.grants?.fullAccess || !context.req.user) {
    return undefined
  }
  const binding = context.options.rowScope
  if (!binding) {
    return undefined
  }
  if (binding.assignments) {
    return whereUsersWithinScope(context.req)
  }
  if (!bindingFiltersRows(binding)) {
    return undefined
  }
  const scope = await loadDirectScope(context.req)
  const actorId = Number(context.req.user?.id)
  if (
    Number.isInteger(actorId) &&
    estimatedScopeBinds(binding, scope, context.action) > D1_SAFE_PAGE_SIZE
  ) {
    return whereBindingIds(context.req, context.collectionSlug, binding, context.action, actorId)
  }
  return whereForBinding(binding, scope, context.action)
}

async function loadDirectScope(req: AccessEvaluationContext['req']): Promise<DirectScope> {
  const [assignments, catalog] = await Promise.all([
    loadScopeAssignments(req),
    loadScopeCatalog(req),
  ])
  const organizationIds = collapseCoveredIds(
    assignments.organizationIds,
    parentMap(catalog.organizations),
  )
  const branchIds = collapseCoveredIds(assignments.branchIds, parentMap(catalog.branches))
  const dataClassIds = collapseCoveredIds(assignments.dataClassIds, parentMap(catalog.dataClasses))
  const branchOrganizationIds: string[] = []
  for (const branchId of branchIds) {
    const organizationId = catalog.branches.get(branchId)?.organizationId
    if (organizationId) {
      branchOrganizationIds.push(organizationId)
    }
  }
  return {
    organizationIds,
    branchIds,
    branchOrganizationIds,
    dataClassIds,
  }
}
