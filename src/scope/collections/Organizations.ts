import type { CollectionConfig } from 'payload'

import { withRbac } from '../../access'
import { withRowScope } from '../hooks/with-row-scope'
import { ORGANIZATIONS_SLUG, SCOPE_PARENT_FIELD } from '../constants'
import { scopePathField } from '../path/scope-path-field'
import { uniqueSlug } from '../validation/unique-slug'

const parentDescription =
  'Parent organization. Assignment to an organization includes every descendant. A parent cannot be this organization or one of its descendants.'

export const Organizations: CollectionConfig = withRowScope(
  withRbac(
    {
      slug: ORGANIZATIONS_SLUG,
      labels: {
        singular: 'Organization',
        plural: 'Organizations',
      },
      admin: {
        useAsTitle: 'name',
        group: 'Organization',
        description: 'Organizational units. Access assigned here includes child organizations.',
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
          validate: uniqueSlug(ORGANIZATIONS_SLUG, 'An organization'),
        },
        {
          name: SCOPE_PARENT_FIELD,
          type: 'relationship',
          relationTo: ORGANIZATIONS_SLUG,
          index: true,
          admin: {
            position: 'sidebar',
            description: parentDescription,
          },
        },
        scopePathField(),
      ],
      graphQL: {
        singularName: 'Organization',
        pluralName: 'Organizations',
      },
    },
    {
      rowScope: {
        dimension: 'organization',
      },
    },
  ),
)
