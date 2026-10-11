import type { ScopeAssignments } from '../types'
import { idSet } from '../ids/id-set'
import {
  USER_BRANCHES_FIELD,
  USER_DATA_CLASSES_FIELD,
  USER_ORGANIZATIONS_FIELD,
} from '../constants'

export function emptyAssignments(): ScopeAssignments {
  return {
    organizationIds: [],
    branchIds: [],
    dataClassIds: [],
  }
}

export function assignmentsFromRecord(record: unknown): ScopeAssignments {
  const source = (record ?? {}) as Record<string, unknown>
  return {
    organizationIds: [...idSet(source[USER_ORGANIZATIONS_FIELD])],
    branchIds: [...idSet(source[USER_BRANCHES_FIELD])],
    dataClassIds: [...idSet(source[USER_DATA_CLASSES_FIELD])],
  }
}
