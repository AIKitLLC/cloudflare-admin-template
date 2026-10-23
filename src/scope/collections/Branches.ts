import type { CollectionConfig } from 'payload'

import { withRbac } from '../../access'
import { withRowScope } from '../hooks/with-row-scope'
import { BRANCHES_SLUG, BRANCH_ORGANIZATION_FIELD, ORGANIZATIONS_SLUG } from '../constants'
import { scopePathField } from '../path/scope-path-field'

export const Branches: CollectionConfig = withRowScope(
  withRbac(
    {
      slug: BRANCHES_SLUG,
      labels: {
        singular: 'Branch',
        plural: 'Branches',
      },
      admin: {
        useAsTitle: 'name',
        group: 'Organization',
        description:
          'Branches belong to one organization. Assignment to an organization includes its branches. Assignment to a branch includes child branches.',
        defaultColumns: ['name', 'slug', 'organization', 'parent'],
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
          name: BRANCH_ORGANIZATION_FIELD,
          type: 'relationship',
          relationTo: ORGANIZATIONS_SLUG,
          required: true,
          index: true,
        },
        {
          name: 'parent',
          type: 'relationship',
          relationTo: BRANCHES_SLUG,
          index: true,
          admin: {
            position: 'sidebar',
            description:
              'Parent branch in the same organization. Assignment includes every descendant branch.',
          },
        },
        scopePathField(),
      ],
      graphQL: {
        singularName: 'Branch',
        pluralName: 'Branches',
      },
    },
    {
      rowScope: {
        dimension: 'branch',
      },
    },
  ),
)
