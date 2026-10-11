import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { adminRbac } from './plugin'

describe('@aikit/admin-rbac', () => {
  it('adds the permission collections to a config that has none', () => {
    const config = adminRbac()({ collections: [] } as Config)
    if (config instanceof Promise) throw new Error('adminRbac is synchronous')
    const slugs = (config.collections ?? []).map((collection) => collection.slug)
    expect(slugs).toEqual(expect.arrayContaining(['roles', 'permissions', 'role-permissions']))
    expect(config.endpoints?.map((endpoint) => endpoint.path)).toEqual(
      expect.arrayContaining(['/rbac/matrix', '/rbac/grants']),
    )
  })
})
