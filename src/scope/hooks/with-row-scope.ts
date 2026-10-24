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
  return {
    ...collection,
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

const HOOK_KEYS = [
  'beforeOperation',
  'beforeChange',
  'beforeDelete',
  'afterChange',
  'afterDelete',
] as const

/**
 * Fails closed when a row-scoped collection does not carry the scope hooks. It checks the hook
 * arrays themselves, so a collection added by a plugin (or a sanitized runtime config) cannot
 * keep filtered reads while silently losing its write guards. `scopeHooksFor` returns the same
 * module-level hook functions on every call, so presence is compared by function identity.
 */
export function assertRowScopeHooks(
  collections: ReadonlyArray<Pick<CollectionConfig, 'custom' | 'hooks' | 'slug'>>,
): void {
  for (const collection of collections) {
    const expected = scopeHooksFor(readRowScopeBinding(collection.custom))
    if (!expected) {
      continue
    }
    for (const key of HOOK_KEYS) {
      const present = (collection.hooks?.[key] ?? []) as unknown[]
      const missing = ((expected[key] ?? []) as unknown[]).filter((hook) => !present.includes(hook))
      if (missing.length > 0) {
        throw new Error(
          `Collection "${collection.slug}" declares a rowScope binding but its ${key} scope hooks are not attached. Wrap it with withRowScope().`,
        )
      }
    }
  }
}
