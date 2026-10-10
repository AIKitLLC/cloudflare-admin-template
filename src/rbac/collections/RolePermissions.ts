import type { CollectionConfig } from 'payload'

import { withRbac } from '../../access/with-rbac'
import { guardRolePermissionDelete, guardRolePermissionWrite } from '../guards/guard-role-grants'

export const RolePermissions: CollectionConfig = withRbac({
  slug: 'role-permissions',
  labels: {
    singular: 'Role Permission',
    plural: 'Role Permissions',
  },
  admin: {
    group: 'Access Control',
    description:
      'Grants joining a role to a permission. The permission matrix edits this collection.',
    defaultColumns: ['role', 'permission', 'granted'],
  },
  indexes: [
    {
      fields: ['role', 'permission'],
      unique: true,
    },
  ],
  hooks: {
    beforeChange: [guardRolePermissionWrite],
    beforeDelete: [guardRolePermissionDelete],
  },
  fields: [
    {
      name: 'role',
      type: 'relationship',
      relationTo: 'roles',
      required: true,
      index: true,
    },
    {
      name: 'permission',
      type: 'relationship',
      relationTo: 'permissions',
      required: true,
      index: true,
    },
    {
      name: 'granted',
      type: 'checkbox',
      defaultValue: true,
    },
  ],
})
