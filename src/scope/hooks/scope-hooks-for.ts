import type {
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionBeforeOperationHook,
  CollectionConfig,
} from 'payload'

import type { RowScopeBinding } from '../../access/types'
import { guardRecordScope } from '../guards/guard-record-scope'
import {
  guardScopeAssignment,
  guardScopeAssignmentOperation,
} from '../guards/guard-scope-assignment'
import { guardScopeNodeDelete } from '../guards/guard-scope-node-delete'
import { guardScopeNode } from '../guards/guard-scope-node'
import { clearScopeCacheAfterChange, clearScopeCacheAfterDelete } from './clear-scope-cache'

export function scopeHooksFor(
  binding: RowScopeBinding | undefined,
): CollectionConfig['hooks'] | undefined {
  if (!binding) {
    return undefined
  }
  const beforeChange: CollectionBeforeChangeHook[] = []
  if (binding.dimension) {
    beforeChange.push(guardScopeNode)
  }
  if (binding.organizationField || binding.branchField || binding.dataClassField) {
    beforeChange.push(guardRecordScope)
  }
  const beforeOperation: CollectionBeforeOperationHook[] = binding.assignments
    ? [guardScopeAssignmentOperation]
    : []
  if (binding.assignments) {
    beforeChange.push(guardScopeAssignment)
  }
  const beforeDelete: CollectionBeforeDeleteHook[] = binding.dimension ? [guardScopeNodeDelete] : []
  const clearsCache = Boolean(binding.dimension || binding.assignments)
  return {
    beforeOperation,
    beforeChange,
    beforeDelete,
    afterChange: clearsCache ? [clearScopeCacheAfterChange] : [],
    afterDelete: clearsCache ? [clearScopeCacheAfterDelete] : [],
  }
}
