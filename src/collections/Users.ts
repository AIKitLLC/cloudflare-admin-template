import type { CollectionConfig } from 'payload'
import {
  guardClientSecurityOwnerChange,
  guardClientSecurityOwnerDelete,
  guardClientSecurityOwnerOperation,
  clearClientSecurityRecoveryOperation,
  isStoredClientSecurityOwner,
} from '../auth/client-security-owner'

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
  },
  auth: true,
  hooks: {
    beforeOperation: [guardClientSecurityOwnerOperation],
    beforeChange: [guardClientSecurityOwnerChange],
    beforeDelete: [guardClientSecurityOwnerDelete],
    afterOperation: [clearClientSecurityRecoveryOperation],
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
      admin: { description: 'Only an owner can change roles. Existing CMS access is preserved.' },
    },
  ],
  versions: false,
}
