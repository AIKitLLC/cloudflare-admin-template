import type { CollectionConfig } from 'payload'

import { withRbac } from '../access/with-rbac'

export const Media: CollectionConfig = withRbac(
  {
    slug: 'media',
    fields: [
      {
        name: 'alt',
        type: 'text',
        required: true,
      },
    ],
    upload: {
      crop: false,
      focalPoint: false,
    },
  },
  {
    anonymousRead: true,
  },
)
