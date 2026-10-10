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
