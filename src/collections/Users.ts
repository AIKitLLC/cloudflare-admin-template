import type { CollectionConfig } from 'payload'

import { withRbac } from '../access/with-rbac'
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
            'Access roles. A user with no roles cannot read or change collections. The roles field itself is not self-service editable.',
        },
      },
    ],
    hooks: {
      afterChange: [assignSuperAdminToFirstUser],
    },
    versions: false,
  },
  {
    selfService: true,
    selfServiceLockedFields: ['roles'],
  },
)
