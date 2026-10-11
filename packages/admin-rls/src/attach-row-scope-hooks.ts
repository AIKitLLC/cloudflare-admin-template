import type { CollectionConfig } from 'payload'
import type { RowScopeBinding } from '@aikit/admin-rbac'

import { scopeHooksFor } from './hooks/scope-hooks-for'

type ScopedCustom = {
  rbac?: { rowScope?: RowScopeBinding }
  rowScopeHooksAttached?: boolean
}

export function attachRowScopeHooks(collections: CollectionConfig[]): void {
  for (const collection of collections) {
    const custom = collection.custom as ScopedCustom | undefined
    const binding = custom?.rbac?.rowScope
    if (!binding || custom?.rowScopeHooksAttached) {
      continue
    }
    const extra = scopeHooksFor(binding)
    if (!extra) {
      continue
    }
    const hooks = collection.hooks
    collection.hooks = {
      ...hooks,
      beforeOperation: [...(hooks?.beforeOperation ?? []), ...(extra.beforeOperation ?? [])],
      beforeChange: [...(hooks?.beforeChange ?? []), ...(extra.beforeChange ?? [])],
      beforeDelete: [...(hooks?.beforeDelete ?? []), ...(extra.beforeDelete ?? [])],
      afterChange: [...(hooks?.afterChange ?? []), ...(extra.afterChange ?? [])],
      afterDelete: [...(hooks?.afterDelete ?? []), ...(extra.afterDelete ?? [])],
    }
    collection.custom = {
      ...(custom ?? {}),
      rowScopeHooksAttached: true,
    }
  }
}
