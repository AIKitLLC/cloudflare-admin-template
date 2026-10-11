import type { CollectionConfig } from 'payload'

import { evaluateCollectionAccess } from '../access/evaluate-collection-access'
import { withRbac } from '../access/with-rbac'
import { withAuditTrail } from '../audit'
import {
  guardAuthCredentialOperation,
  guardLastFullAccessDeletion,
  guardUserRoleAssignment,
} from '../rbac/guards/guard-full-access-assignment'
import { assignSuperAdminToFirstUser } from '../rbac/hooks/assign-super-admin-to-first-user'

export const Users: CollectionConfig = withAuditTrail(
  withRbac(
    {
      slug: 'users',
      admin: {
        useAsTitle: 'email',
      },
      auth: true,
      access: {
        admin: ({ req }) => Boolean(req.user),
        // Payload writes unlock directly, so collection beforeChange never sees it.
        // Same permission as update; the credential hook still compares the target.
        unlock: ({ req }) =>
          evaluateCollectionAccess({
            req,
            collectionSlug: 'users',
            action: 'update',
          }),
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
        beforeOperation: [guardAuthCredentialOperation],
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
  ),
  {
    redactFields: ['password', 'hash', 'salt', 'resetPasswordToken', 'sessions'],
  },
)
