import type { CollectionConfig } from 'payload'

import { PERMISSION_ACTIONS } from '../../access/constants'
import { withRbac } from '../../access/with-rbac'
import { JOB_DISPATCH_ACTIONS } from '../../jobs/constants'

export const Permissions: CollectionConfig = withRbac({
  slug: 'permissions',
  labels: {
    singular: 'Permission',
    plural: 'Permissions',
  },
  admin: {
    useAsTitle: 'key',
    group: 'Access Control',
    description:
      'Catalog of collection actions and field permissions. Synced from the Payload config on startup.',
    defaultColumns: ['key', 'collectionSlug', 'action', 'fieldPath', 'active'],
  },
  access: {
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    {
      name: 'key',
      type: 'text',
      required: true,
      unique: true,
      index: true,
    },
    {
      name: 'label',
      type: 'text',
      required: true,
    },
    {
      name: 'description',
      type: 'textarea',
    },
    {
      name: 'collectionSlug',
      type: 'text',
      required: true,
      index: true,
    },
    {
      name: 'action',
      type: 'select',
      required: true,
      options: [...PERMISSION_ACTIONS, ...JOB_DISPATCH_ACTIONS].map((action) => ({
        label: action,
        value: action,
      })),
    },
    {
      name: 'fieldPath',
      type: 'text',
      admin: {
        description: 'Empty for collection actions. Dotted path for field permissions.',
      },
    },
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      admin: {
        description:
          'Inactive permissions belong to collections or fields that are no longer in the config.',
      },
    },
  ],
})
