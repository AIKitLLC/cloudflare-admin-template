import { isIdSubset } from '../ids/id-set'
import type { EffectiveScope } from '../types'

/** Inherited scope included. An empty target is outside every limited scope. */
export function isScopeWithin(target: EffectiveScope, actor: EffectiveScope): boolean {
  if (!hasAnyScope(target)) {
    return false
  }
  return (
    isIdSubset(target.grantableOrganizationIds, actor.grantableOrganizationIds) &&
    isIdSubset(target.organizationIds, actor.organizationIds) &&
    isIdSubset(target.branchIds, actor.branchIds) &&
    isIdSubset(target.dataClassIds, actor.dataClassIds)
  )
}

function hasAnyScope(scope: EffectiveScope): boolean {
  return (
    scope.grantableOrganizationIds.size > 0 ||
    scope.branchIds.size > 0 ||
    scope.dataClassIds.size > 0
  )
}
