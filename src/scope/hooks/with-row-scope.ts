import type { CollectionConfig } from 'payload'

import { readRowScopeBinding } from '../bindings/read-row-scope-binding'
import { scopeHooksFor } from './scope-hooks-for'

/**
 * Appends the row-scope guard hooks for the binding that `withRbac` stored at
 * `custom.rbac.rowScope`. Wrap each row-scoped collection directly around its
 * `withRbac(...)` so scope hooks keep their position ahead of later wrappers.
 */
export function withRowScope(collection: CollectionConfig): CollectionConfig {
  const extra = scopeHooksFor(readRowScopeBinding(collection.custom))
  if (!extra) {
    return collection
  }
  const hooks = collection.hooks
  const custom = (collection.custom ?? {}) as { rbac?: Record<string, unknown> }
  return {
    ...collection,
    custom: {
      ...custom,
      rbac: { ...(custom.rbac ?? {}), rowScopeHooks: true },
    },
    hooks: {
      ...hooks,
      beforeOperation: [...(hooks?.beforeOperation ?? []), ...(extra.beforeOperation ?? [])],
      beforeChange: [...(hooks?.beforeChange ?? []), ...(extra.beforeChange ?? [])],
      beforeDelete: [...(hooks?.beforeDelete ?? []), ...(extra.beforeDelete ?? [])],
      afterChange: [...(hooks?.afterChange ?? []), ...(extra.afterChange ?? [])],
      afterDelete: [...(hooks?.afterDelete ?? []), ...(extra.afterDelete ?? [])],
    },
  }
}

/** Fails closed when a row-scoped collection was not wrapped with `withRowScope`. */
export function assertRowScopeHooks(collections: CollectionConfig[]): void {
  for (const collection of collections) {
    if (!scopeHooksFor(readRowScopeBinding(collection.custom))) {
      continue
    }
    const rbac = (collection.custom as { rbac?: { rowScopeHooks?: boolean } }).rbac
    if (rbac?.rowScopeHooks !== true) {
      throw new Error(
        `Collection "${collection.slug}" declares a rowScope binding but its scope hooks are not attached. Wrap it with withRowScope().`,
      )
    }
  }
}
