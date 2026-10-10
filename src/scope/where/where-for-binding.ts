import type { Where } from 'payload'

import type { CollectionAction, RowScopeBinding } from '../../access/types'
import type { EffectiveScope } from '../types'
import { matchNothing } from './match-nothing'
import { whereIdIn } from './where-id-in'

export function whereForBinding(
  binding: RowScopeBinding,
  scope: EffectiveScope,
  action: CollectionAction,
): Where {
  if (binding.dimension === 'organization') {
    const ids =
      action === 'read' || action === 'export'
        ? scope.organizationIds
        : scope.grantableOrganizationIds
    return whereIdIn('id', ids)
  }
  if (binding.dimension === 'branch') {
    return whereIdIn('id', scope.branchIds)
  }
  if (binding.dimension === 'data-class') {
    return whereIdIn('id', scope.dataClassIds)
  }

  const parts: Where[] = []
  if (binding.organizationField) {
    parts.push(whereIdIn(binding.organizationField, scope.organizationIds))
  }
  if (binding.branchField) {
    parts.push(whereIdIn(binding.branchField, scope.branchIds))
  }
  if (binding.dataClassField) {
    parts.push(whereIdIn(binding.dataClassField, scope.dataClassIds))
  }
  if (parts.length === 0) {
    return matchNothing()
  }
  if (parts.length === 1) {
    return parts[0]
  }
  return { and: parts }
}
