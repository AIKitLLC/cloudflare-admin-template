import type { CollectionConfig } from 'payload'

import { withRbac } from '../access/with-rbac'
import { withAuditTrail } from '../audit'

export const Media: CollectionConfig = withAuditTrail(
  withRbac(
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
  ),
)
