import type { CollectionConfig } from 'payload'

import { withRbac } from '../../access/with-rbac'
import { DATA_CLASSES_SLUG } from '../constants'

export const DataClasses: CollectionConfig = withRbac(
  {
    slug: DATA_CLASSES_SLUG,
    labels: {
      singular: 'Data Class',
      plural: 'Data Classes',
    },
    admin: {
      useAsTitle: 'name',
      group: 'Organization',
      description:
        'Data classes form groups. Assignment to a group includes every class nested under it.',
      defaultColumns: ['name', 'slug', 'parent'],
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
      },
      {
        name: 'parent',
        type: 'relationship',
        relationTo: DATA_CLASSES_SLUG,
        index: true,
        admin: {
          position: 'sidebar',
          description:
            'Group that contains this class. Nested groups are included in the assignment.',
        },
      },
    ],
    graphQL: {
      singularName: 'DataClass',
      pluralName: 'DataClasses',
    },
  },
  {
    rowScope: {
      dimension: 'data-class',
    },
  },
)
