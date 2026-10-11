import { describe, expect, it } from 'vitest'

import { AUDIT_REDACT_WHEN_SENSITIVE, isInternalCollection } from './index'

describe('@aikit/admin-core', () => {
  it('shares the sensitive-field flag and the internal collection prefix', () => {
    expect(AUDIT_REDACT_WHEN_SENSITIVE).toBe('whenSensitive')
    expect(isInternalCollection('payload-migrations')).toBe(true)
    expect(isInternalCollection('users')).toBe(false)
  })
})
