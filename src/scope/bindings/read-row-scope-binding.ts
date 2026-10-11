import type { RowScopeBinding } from '../../access/types'

export function readRowScopeBinding(custom: unknown): RowScopeBinding | undefined {
  if (!custom || typeof custom !== 'object' || !('rbac' in custom)) {
    return undefined
  }
  const rbac = (custom as { rbac?: { rowScope?: RowScopeBinding } }).rbac
  return rbac?.rowScope
}

export function bindingFiltersRows(binding: RowScopeBinding | undefined): boolean {
  if (!binding) {
    return false
  }
  return Boolean(
    binding.dimension || binding.organizationField || binding.branchField || binding.dataClassField,
  )
}
