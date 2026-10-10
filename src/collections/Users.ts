import type { CollectionConfig } from 'payload'

import { evaluateCollectionAccess } from '../access/evaluate-collection-access'
import { isPermissionPayloadCall, permissionDocumentId } from '../access/permission-payload-call'
import { withRbac } from '../access/with-rbac'
import {
  guardAuthCredentialOperation,
  guardLastFullAccessDeletion,
  guardUserRoleAssignment,
} from '../rbac/guards/guard-full-access-assignment'
import { assignSuperAdminToFirstUser } from '../rbac/hooks/assign-super-admin-to-first-user'
import {
  USER_BRANCHES_FIELD,
  USER_DATA_CLASSES_FIELD,
  USER_ORGANIZATIONS_FIELD,
} from '../scope/constants'

export const Users: CollectionConfig = withRbac(
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
      unlock: (args) =>
        evaluateCollectionAccess({
          req: args.req,
          collectionSlug: 'users',
          action: 'update',
          permissionProbe: isPermissionPayloadCall(args),
          documentId: permissionDocumentId(args),
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
      {
        name: USER_ORGANIZATIONS_FIELD,
        type: 'relationship',
        relationTo: 'organizations',
        hasMany: true,
        admin: {
          position: 'sidebar',
          description:
            'Organizations this user can access, including descendant organizations and their branches. Users cannot change their own assignments.',
        },
      },
      {
        name: USER_BRANCHES_FIELD,
        type: 'relationship',
        relationTo: 'branches',
        hasMany: true,
        admin: {
          position: 'sidebar',
          description:
            'Branches this user can access, including descendant branches. Organization assignments already include the branches under those organizations.',
        },
      },
      {
        name: USER_DATA_CLASSES_FIELD,
        type: 'relationship',
        relationTo: 'data-classes',
        hasMany: true,
        admin: {
          position: 'sidebar',
          description:
            'Data classes this user can access, including classes nested in an assigned group. A collection that stores a data class denies rows when this is empty.',
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
    rowScope: {
      assignments: true,
    },
  },
)
