import type { ScopeAssignments, ScopeCatalog, EffectiveScope } from '../types'
import { parentMap, ScopeTree } from '../tree/scope-tree'

export function resolveEffectiveScope(
  catalog: ScopeCatalog,
  assignments: ScopeAssignments,
): EffectiveScope {
  const organizationTree = new ScopeTree(parentMap(catalog.organizations))
  const branchTree = new ScopeTree(parentMap(catalog.branches))
  const dataClassTree = new ScopeTree(parentMap(catalog.dataClasses))

  const grantableOrganizationIds = organizationTree.close(assignments.organizationIds)
  const directBranchIds = branchTree.close(assignments.branchIds)

  const impliedBranchSeeds: string[] = []
  for (const [id, branch] of catalog.branches) {
    if (branch.organizationId && grantableOrganizationIds.has(branch.organizationId)) {
      impliedBranchSeeds.push(id)
    }
  }

  const branchIds = branchTree.close([...directBranchIds, ...impliedBranchSeeds])
  const organizationIds = new Set(grantableOrganizationIds)
  for (const branchId of directBranchIds) {
    const organizationId = catalog.branches.get(branchId)?.organizationId
    if (organizationId) {
      organizationIds.add(organizationId)
    }
  }

  return {
    organizationIds,
    grantableOrganizationIds,
    branchIds,
    dataClassIds: dataClassTree.close(assignments.dataClassIds),
  }
}
