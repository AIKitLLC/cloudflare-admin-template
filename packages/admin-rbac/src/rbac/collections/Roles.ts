import type { CollectionConfig } from 'payload'

import { withRbac } from '../../access/with-rbac'
import { preventSuperAdminDeletion, protectSuperAdminRole } from '../hooks/protect-super-admin-role'

export const Roles: CollectionConfig = withRbac({
  slug: 'roles',
  labels: {
    singular: 'Role',
    plural: 'Roles',
  },
  admin: {
    useAsTitle: 'name',
    group: 'Access Control',
    description: 'Named access roles. The super-admin role bypasses the permission matrix.',
    defaultColumns: ['name', 'slug', 'grantsFullAccess'],
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: {
        description: 'Stable identifier, for example super-admin or support.',
      },
    },
    {
      name: 'description',
      type: 'textarea',
    },
    {
      name: 'grantsFullAccess',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description:
          'Bypasses every collection, action, and field check. Reserved for super-admin.',
      },
    },
  ],
  hooks: {
    beforeChange: [protectSuperAdminRole],
    beforeDelete: [preventSuperAdminDeletion],
  },
})
