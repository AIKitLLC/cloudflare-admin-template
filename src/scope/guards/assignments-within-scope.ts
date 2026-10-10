import { isIdSubset } from '../ids/id-set'
import { assignmentsFromRecord } from '../resolve/assignments-from-record'
import type { EffectiveScope } from '../types'

/** Direct assignments must sit inside the actor's inherited scope. Empty assignments are inside every scope. */
export function assignmentsWithinScope(record: unknown, scope: EffectiveScope): boolean {
  const assignments = assignmentsFromRecord(record)
  return (
    isIdSubset(new Set(assignments.organizationIds), scope.grantableOrganizationIds) &&
    isIdSubset(new Set(assignments.branchIds), scope.branchIds) &&
    isIdSubset(new Set(assignments.dataClassIds), scope.dataClassIds)
  )
}
