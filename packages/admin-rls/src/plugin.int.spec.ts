import type { CollectionConfig, Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { withRbac } from '@aikit/admin-rbac'

import { adminRls } from './plugin'

describe('@aikit/admin-rls', () => {
  it('adds scope collections and attaches row hooks declared on withRbac', () => {
    const notes: CollectionConfig = withRbac(
      { slug: 'notes', fields: [] },
      { rowScope: { organizationField: 'ownerOrganization' } },
    )
    const config = adminRls()({ collections: [notes] } as Config)
    if (config instanceof Promise) throw new Error('adminRls is synchronous')
    const slugs = (config.collections ?? []).map((collection) => collection.slug)
    expect(slugs).toEqual(
      expect.arrayContaining(['organizations', 'branches', 'data-classes', 'records', 'notes']),
    )
    const wrapped = config.collections?.find((collection) => collection.slug === 'notes')
    expect(wrapped?.hooks?.beforeChange?.length).toBeGreaterThan(0)
  })
})
