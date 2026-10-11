import type { CollectionBeforeChangeHook } from 'payload'
import { APIError } from 'payload'

import type { RowScopeBinding } from '../../access/types'
import { userGrantsFullAccess } from '../../access/resolve/load-user-grants'
import { relationId } from '../../access/relation-id'
import { skipsPrivilegeChecks } from '../../rbac/guards/privilege-context'
import { readRowScopeBinding } from '../bindings/read-row-scope-binding'
import { SCOPE_RECORD_ERROR, SCOPE_RECORD_MISMATCH_ERROR } from '../errors'
import { loadEffectiveScope } from '../resolve/load-effective-scope'
import { loadScopeCatalog } from '../resolve/load-scope-catalog'

export const guardRecordScope: CollectionBeforeChangeHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  if (!data) {
    return data
  }
  const binding = readRowScopeBinding(collection?.custom)
  if (!binding?.organizationField && !binding?.branchField && !binding?.dataClassField) {
    return data
  }
  if (skipsPrivilegeChecks(req.context) || !req.user || (await userGrantsFullAccess(req))) {
    return data
  }

  const scope = await loadEffectiveScope(req)
  const record = data as Record<string, unknown>
  const original = originalDoc as Record<string, unknown> | undefined
  assertField(binding.organizationField, record, original, scope.organizationIds)
  assertField(binding.branchField, record, original, scope.branchIds)
  assertField(binding.dataClassField, record, original, scope.dataClassIds)
  if (binding.organizationField && binding.branchField) {
    await assertBranchBelongsToOrganization(req, binding, record, original)
  }
  return data
}

function assertField(
  field: string | undefined,
  data: Record<string, unknown>,
  original: Record<string, unknown> | undefined,
  allowed: ReadonlySet<string>,
): void {
  if (!field) {
    return
  }
  const raw = data[field] === undefined ? original?.[field] : data[field]
  const id = relationId(raw)
  if (!id || !allowed.has(id)) {
    throw new APIError(SCOPE_RECORD_ERROR, 403)
  }
}

async function assertBranchBelongsToOrganization(
  req: Parameters<CollectionBeforeChangeHook>[0]['req'],
  binding: RowScopeBinding,
  data: Record<string, unknown>,
  original: Record<string, unknown> | undefined,
): Promise<void> {
  const organizationId = relationId(
    data[binding.organizationField as string] === undefined
      ? original?.[binding.organizationField as string]
      : data[binding.organizationField as string],
  )
  const branchId = relationId(
    data[binding.branchField as string] === undefined
      ? original?.[binding.branchField as string]
      : data[binding.branchField as string],
  )
  if (!organizationId || !branchId) {
    return
  }
  const catalog = await loadScopeCatalog(req)
  const branch = catalog.branches.get(branchId)
  if (!branch?.organizationId || branch.organizationId !== organizationId) {
    throw new APIError(SCOPE_RECORD_MISMATCH_ERROR, 400)
  }
}
