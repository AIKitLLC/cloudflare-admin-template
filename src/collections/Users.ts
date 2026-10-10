import type { CollectionConfig } from 'payload'

import { withRbac } from '../access/with-rbac'
import {
  guardLastFullAccessDeletion,
  guardUserRoleAssignment,
} from '../rbac/guards/guard-full-access-assignment'
import { assignSuperAdminToFirstUser } from '../rbac/hooks/assign-super-admin-to-first-user'

export const Users: CollectionConfig = withRbac(
  {
    slug: 'users',
    admin: {
      useAsTitle: 'email',
    },
    auth: true,
    access: {
      admin: ({ req }) => Boolean(req.user),
    },
    fields: [
      {
        name: 'roles',
        type: 'relationship',
        relationTo: 'roles',
        hasMany: true,
        admin: {
          position: 'sidebar',
          description:
            'Access roles. A user with no roles cannot read or change collections. Self-service edits cannot change roles.',
        },
      },
    ],
    hooks: {
      beforeChange: [guardUserRoleAssignment],
      beforeDelete: [guardLastFullAccessDeletion],
      afterChange: [assignSuperAdminToFirstUser],
    },
    versions: false,
  },
  {
    selfService: true,
    selfServiceFields: ['email', 'password'],
  },
)
