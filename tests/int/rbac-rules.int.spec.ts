import { describe, expect, it } from 'vitest'

import { omitAuthSecrets } from '@/access/export/create-export-endpoint'
import { permissionKey } from '@/access/permission-key'
import { toCsv } from '@/access/export/to-csv'
import {
  earliestUser,
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

  it('selects the earliest user by createdAt, then id', () => {
    expect(earliestUser([])).toBeUndefined()
    expect(
      earliestUser([
        { id: 3, createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 9, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 4, createdAt: '2026-01-01T00:00:00.000Z' },
      ])?.id,
    ).toBe(4)
    expect(
      earliestUser([
        { id: '10', createdAt: null },
        { id: '2', createdAt: null },
      ])?.id,
    ).toBe('2')
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
    const csv = toCsv([
      { id: 1, name: '=cmd', note: 'say "hi"', amount: -12.5, padded: '\t=cmd', broken: '\r=cmd' },
    ])
    expect(csv.split('\n')[0]).toBe('id,amount,broken,name,note,padded')
    expect(csv).toContain("'=cmd")
    expect(csv).toContain('"say ""hi"""')
    expect(csv).toContain('-12.5')
    expect(csv).not.toContain("'-12.5")
    expect(csv).toContain("'\t=cmd")
    expect(csv).toContain("'\r=cmd")
  })

  it('drops auth secrets before they can reach a csv row', () => {
    const visible = omitAuthSecrets({
      id: 1,
      email: 'a@example.com',
      hash: 'secret-hash',
      salt: 'secret-salt',
      resetPasswordToken: 'token',
      resetPasswordRequestedAt: '2026-10-17T00:00:00.000Z',
      sessions: [{ id: 's' }],
    })
    expect(visible).toEqual({ id: 1, email: 'a@example.com' })
    expect(toCsv([visible])).not.toContain('secret-hash')
  })
})
