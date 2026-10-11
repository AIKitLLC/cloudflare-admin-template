import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { adminJobs } from './plugin'

describe('@aikit/admin-jobs', () => {
  it('adds the jobs collection and the retry mutation', () => {
    const config = adminJobs()({ collections: [] } as Config)
    if (config instanceof Promise) throw new Error('adminJobs is synchronous')
    expect(config.collections?.map((collection) => collection.slug)).toContain('jobs')
    expect(config.graphQL?.mutations).toBeTypeOf('function')
  })
})
