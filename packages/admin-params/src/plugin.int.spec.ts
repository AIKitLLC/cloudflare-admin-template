import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { adminParams } from './plugin'

describe('@aikit/admin-params', () => {
  it('adds the system-parameters collection', () => {
    const config = adminParams()({ collections: [] } as Config)
    if (config instanceof Promise) throw new Error('adminParams is synchronous')
    expect(config.collections?.map((collection) => collection.slug)).toContain('system-parameters')
  })
})
