import { isIdSubset } from '../ids/id-set'
import type { EffectiveScope } from '../types'

/** Inherited scope included. The target must not be able to see or grant anything the actor cannot. */
export function isScopeWithin(target: EffectiveScope, actor: EffectiveScope): boolean {
  return (
    isIdSubset(target.grantableOrganizationIds, actor.grantableOrganizationIds) &&
    isIdSubset(target.organizationIds, actor.organizationIds) &&
    isIdSubset(target.branchIds, actor.branchIds) &&
    isIdSubset(target.dataClassIds, actor.dataClassIds)
  )
}
