import type { Where } from 'payload'

import type { CollectionAction, RowScopeBinding } from '../../access/types'
import { SCOPE_PATH_FIELD } from '../constants'
import type { DirectScope } from './direct-scope'
import { matchNothing } from './match-nothing'
import { whereIdIn } from './where-id-in'
import { whereOwnPathContains, wherePathContains } from './where-path-contains'

export function whereForBinding(
  binding: RowScopeBinding,
  scope: DirectScope,
  action: CollectionAction,
): Where {
  if (binding.dimension === 'organization') {
    if (action === 'read' || action === 'export') {
      return anyOf([
        wherePathContains(SCOPE_PATH_FIELD, scope.organizationIds),
        idList(scope.branchOrganizationIds),
      ])
    }
    return whereOwnPathContains(scope.organizationIds)
  }
  if (binding.dimension === 'branch') {
    return anyOf([
      wherePathContains(SCOPE_PATH_FIELD, scope.branchIds),
      wherePathContains(`organization.${SCOPE_PATH_FIELD}`, scope.organizationIds),
    ])
  }
  if (binding.dimension === 'data-class') {
    return whereOwnPathContains(scope.dataClassIds)
  }

  const parts: Where[] = []
  if (binding.organizationField) {
    parts.push(
      anyOf([
        wherePathContains(
          `${binding.organizationField}.${SCOPE_PATH_FIELD}`,
          scope.organizationIds,
        ),
        relationshipIn(binding.organizationField, scope.branchOrganizationIds),
      ]),
    )
  }
  if (binding.branchField) {
    parts.push(
      anyOf([
        wherePathContains(`${binding.branchField}.${SCOPE_PATH_FIELD}`, scope.branchIds),
        wherePathContains(
          `${binding.branchField}.organization.${SCOPE_PATH_FIELD}`,
          scope.organizationIds,
        ),
      ]),
    )
  }
  if (binding.dataClassField) {
    parts.push(
      wherePathContains(`${binding.dataClassField}.${SCOPE_PATH_FIELD}`, scope.dataClassIds) ??
        matchNothing(),
    )
  }
  if (parts.length === 0) {
    return matchNothing()
  }
  if (parts.length === 1) {
    return parts[0]
  }
  return { and: parts }
}

function idList(ids: readonly string[]): Where | undefined {
  return relationshipIn('id', ids)
}

function relationshipIn(field: string, ids: readonly string[]): Where | undefined {
  if (ids.length === 0) {
    return undefined
  }
  return whereIdIn(field, new Set(ids))
}

/**
 * Bound parameters a Payload Where for this scope would use.
 * A relationship `in` stores each id as a number and a string, about two parameters.
 * Document `id IN` is inlined, but branch-organization ids on a record are relationship ids.
 */
export function estimatedScopeBinds(
  binding: RowScopeBinding,
  scope: DirectScope,
  action: CollectionAction,
): number {
  const organizations = distinctCount(scope.organizationIds)
  const branches = distinctCount(scope.branchIds)
  const classes = distinctCount(scope.dataClassIds)
  const branchOrganizations = distinctCount(scope.branchOrganizationIds) * 2
  if (binding.dimension === 'organization') {
    if (action === 'read' || action === 'export') {
      return organizations + branchOrganizations
    }
    return organizations
  }
  if (binding.dimension === 'branch') {
    return branches + organizations
  }
  if (binding.dimension === 'data-class') {
    return classes
  }
  let total = 0
  if (binding.organizationField) {
    total += organizations + branchOrganizations
  }
  if (binding.branchField) {
    total += branches + organizations
  }
  if (binding.dataClassField) {
    total += classes
  }
  return total
}

function distinctCount(ids: readonly string[]): number {
  return new Set(ids.filter((id) => id.length > 0)).size
}

function anyOf(parts: Array<Where | undefined>): Where {
  const present = parts.filter((part): part is Where => part !== undefined)
  if (present.length === 0) {
    return matchNothing()
  }
  if (present.length === 1) {
    return present[0]
  }
  return { or: present }
}
