import type { CollectionConfig } from 'payload'
import {
  guardClientSecurityOwnerChange,
  guardClientSecurityOwnerDelete,
  guardClientSecurityOwnerOperation,
  clearClientSecurityRecoveryOperation,
  isStoredClientSecurityOwner,
} from '../auth/client-security-owner'

import { guardPublicUserCreation } from '../auth/first-admin'
import { releaseLoginAttempt, throttleAuthOperation } from '../auth/login-throttle'
import { usersAuthOptions } from '../auth/users-auth'
import { evaluateCollectionAccess } from '../access/evaluate-collection-access'
import { isPermissionPayloadCall, permissionDocumentId } from '../access/permission-payload-call'
import { withRbac } from '../access/with-rbac'
import { withAuditTrail } from '../audit'
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

export const Users: CollectionConfig = withAuditTrail(
  withRbac(
    {
      slug: 'users',
      admin: {
        useAsTitle: 'email',
      },
      auth: usersAuthOptions(),
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
          name: 'role',
          type: 'select',
          required: true,
          defaultValue: 'admin',
          access: {
            create: ({ req }) => isStoredClientSecurityOwner(req.payload, req.user),
            update: ({ req }) => isStoredClientSecurityOwner(req.payload, req.user),
          },
          options: [
            { label: 'Owner', value: 'owner' },
            { label: 'Admin', value: 'admin' },
            { label: 'Editor', value: 'editor' },
          ],
          admin: {
            description:
              'Client security role. Only an owner can change it. Collection access comes from Roles.',
          },
        },
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
        beforeOperation: [
          throttleAuthOperation,
          guardPublicUserCreation,
          guardClientSecurityOwnerOperation,
          guardAuthCredentialOperation,
        ],
        afterLogin: [releaseLoginAttempt],
        beforeChange: [guardClientSecurityOwnerChange, guardUserRoleAssignment],
        beforeDelete: [guardClientSecurityOwnerDelete, guardLastFullAccessDeletion],
        afterChange: [assignSuperAdminToFirstUser],
        afterOperation: [clearClientSecurityRecoveryOperation],
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
  ),
  {
    redactFields: ['password', 'hash', 'salt', 'resetPasswordToken', 'sessions'],
  },
)
