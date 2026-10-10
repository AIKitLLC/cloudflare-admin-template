import { APIError } from 'payload'

import type { AccessConstraint, AccessEvaluationContext } from '../access/types'
import { bindingFiltersRows } from './bindings/read-row-scope-binding'
import { MAX_DIRECT_ASSIGNMENTS } from './constants'
import { SCOPE_ASSIGNMENT_READ_ERROR } from './errors'
import { loadScopeAssignments } from './resolve/load-scope-assignments'
import { loadScopeCatalog } from './resolve/load-scope-catalog'
import { parentMap } from './tree/scope-tree'
import type { DirectScope } from './where/direct-scope'
import { collapseCoveredIds } from './where/collapse-covered-ids'
import { whereForBinding } from './where/where-for-binding'
import { userIsVisible, whereUsersWithinScope } from './where/where-users-within-scope'

export async function contributeRowScope(
  context: AccessEvaluationContext,
): Promise<AccessConstraint | undefined> {
  if (context.action === 'create' || context.grants?.fullAccess || !context.req.user) {
    return undefined
  }
  const binding = context.options.rowScope
  if (!binding) {
    return undefined
  }
  if (binding.assignments) {
    if (context.permissionProbe) {
      return permissionPayloadForUsers(context)
    }
    await loadDirectScope(context.req)
    return whereUsersWithinScope(context.req)
  }
  if (!bindingFiltersRows(binding)) {
    return undefined
  }
  const scope = await loadDirectScope(context.req)
  return whereForBinding(binding, scope, context.action)
}

/**
 * Collection-level permission props stay a one-id Where so the list page can
 * show permission: true without the visible-user list. A document id is checked
 * on its own and returned as a boolean. Neither result is an unscoped allow.
 */
async function permissionPayloadForUsers(
  context: AccessEvaluationContext,
): Promise<AccessConstraint> {
  const actorId = context.req.user?.id
  if (actorId === undefined || actorId === null) {
    return false
  }
  if (context.documentId !== undefined) {
    await loadDirectScope(context.req)
    return userIsVisible(context.req, context.documentId)
  }
  return { id: { equals: actorId } }
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
  const scope = {
    organizationIds,
    branchIds,
    branchOrganizationIds,
    dataClassIds,
  }
  const assignmentCount = organizationIds.length + branchIds.length + dataClassIds.length
  if (assignmentCount > MAX_DIRECT_ASSIGNMENTS) {
    req.payload.logger.error({
      msg: SCOPE_ASSIGNMENT_READ_ERROR,
      userId: req.user?.id,
      assignmentCount,
    })
    throw new APIError(SCOPE_ASSIGNMENT_READ_ERROR, 403)
  }
  return scope
}
