import type { CollectionConfig } from 'payload'

import { withRbac } from '../../access'
import { withRowScope } from '../hooks/with-row-scope'
import { DATA_CLASSES_SLUG } from '../constants'
import { scopePathField } from '../path/scope-path-field'
import { scopeSlugField } from './scope-slug-field'

export const DataClasses: CollectionConfig = withRowScope(
  withRbac(
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
        scopeSlugField(),
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
        scopePathField(),
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
  ),
)
