import type { CollectionConfig } from 'payload'

import { withRbac } from '@aikit/admin-rbac'
import {
  BRANCHES_SLUG,
  DATA_CLASSES_SLUG,
  ORGANIZATIONS_SLUG,
  RECORD_BRANCH_FIELD,
  RECORD_DATA_CLASS_FIELD,
  RECORDS_SLUG,
} from '../constants'

export const Records: CollectionConfig = withRbac(
  {
    slug: RECORDS_SLUG,
    labels: {
      singular: 'Record',
      plural: 'Records',
    },
    admin: {
      useAsTitle: 'title',
      group: 'Organization',
      description:
        'Example scoped collection. Reads, updates, deletes, and exports are limited to the signed-in user organization, branch, and data class.',
      defaultColumns: ['title', 'organization', 'branch', 'dataClass'],
    },
    fields: [
      {
        name: 'title',
        type: 'text',
        required: true,
      },
      {
        name: 'organization',
        type: 'relationship',
        relationTo: ORGANIZATIONS_SLUG,
        required: true,
        index: true,
      },
      {
        name: RECORD_BRANCH_FIELD,
        type: 'relationship',
        relationTo: BRANCHES_SLUG,
        required: true,
        index: true,
      },
      {
        name: RECORD_DATA_CLASS_FIELD,
        type: 'relationship',
        relationTo: DATA_CLASSES_SLUG,
        required: true,
        index: true,
      },
    ],
    graphQL: {
      singularName: 'Record',
      pluralName: 'Records',
    },
  },
  {
    rowScope: {
      organizationField: 'organization',
      branchField: RECORD_BRANCH_FIELD,
      dataClassField: RECORD_DATA_CLASS_FIELD,
    },
  },
)
