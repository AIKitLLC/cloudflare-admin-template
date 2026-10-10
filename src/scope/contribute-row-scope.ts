import type { Where } from 'payload'

import type { AccessEvaluationContext } from '../access/types'
import { bindingFiltersRows } from './bindings/read-row-scope-binding'
import { loadScopeAssignments } from './resolve/load-scope-assignments'
import { loadScopeCatalog } from './resolve/load-scope-catalog'
import { parentMap } from './tree/scope-tree'
import type { DirectScope } from './where/direct-scope'
import { collapseCoveredIds } from './where/collapse-covered-ids'
import { whereForBinding } from './where/where-for-binding'
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
    // Permission payloads omit the id list. Queries leave permissionProbe unset.
    if (context.permissionProbe) {
      return undefined
    }
    return whereUsersWithinScope(context.req)
  }
  if (!bindingFiltersRows(binding)) {
    return undefined
  }
  const scope = await loadDirectScope(context.req)
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
