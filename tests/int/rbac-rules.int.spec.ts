import { describe, expect, it } from 'vitest'

import { permissionKey } from '@/access/permission-key'
import { toCsv } from '@/access/export/to-csv'
import {
  shouldAssignSuperAdminOnCreate,
  shouldPromoteUnassignedUsers,
} from '@/rbac/seed/promotion-policy'

describe('RBAC rules', () => {
  it('builds collection and field permission keys', () => {
    expect(permissionKey('media', 'read')).toBe('media:read')
    expect(permissionKey('users', 'readField', 'email')).toBe('users:readField:email')
    expect(permissionKey('users', 'writeField', 'roles')).toBe('users:writeField:roles')
  })

  it('promotes existing users only when nobody has a role yet', () => {
    expect(shouldPromoteUnassignedUsers([])).toBe(false)
    expect(shouldPromoteUnassignedUsers([{ roles: [] }, { roles: null }])).toBe(true)
    expect(shouldPromoteUnassignedUsers([{ roles: [1] }, { roles: [] }])).toBe(false)
  })

  it('assigns super-admin only to the first user created without roles', () => {
    expect(
      shouldAssignSuperAdminOnCreate({
        operation: 'create',
        assignedRoleCount: 0,
        totalUsers: 1,
      }),
    ).toBe(true)
    expect(
      shouldAssignSuperAdminOnCreate({
        operation: 'create',
        assignedRoleCount: 1,
        totalUsers: 1,
      }),
    ).toBe(false)
    expect(
      shouldAssignSuperAdminOnCreate({
        operation: 'create',
        assignedRoleCount: 0,
        totalUsers: 2,
      }),
    ).toBe(false)
    expect(
      shouldAssignSuperAdminOnCreate({
        operation: 'update',
        assignedRoleCount: 0,
        totalUsers: 1,
      }),
    ).toBe(false)
  })

  it('escapes csv formulas and quotes', () => {
    const csv = toCsv([{ id: 1, name: '=cmd', note: 'say "hi"' }])
    expect(csv.split('\n')[0]).toBe('id,name,note')
    expect(csv).toContain("'=cmd")
    expect(csv).toContain('"say ""hi"""')
  })
})
