import type { CollectionConfig } from 'payload'

import { withRbac } from '../access'
import { withAuditTrail } from '../audit'

/** Largest file `POST`/`PATCH /api/media` accepts. Payload turns a bigger one into a 413 (`upload` in `payload.config.ts`). */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024

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
