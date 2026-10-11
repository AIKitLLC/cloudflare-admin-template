import type { CollectionConfig } from 'payload'

import { withAuditTrail } from '../audit'

export const Users: CollectionConfig = withAuditTrail(
  {
    slug: 'users',
    admin: {
      useAsTitle: 'email',
    },
    auth: true,
    fields: [
      // Email added by default
      // Add more fields as needed
    ],
    versions: false,
  },
  {
    // Defaults already redact these. Listed here so the auth collection's secrets stay obvious.
    redactFields: ['password', 'hash', 'salt', 'resetPasswordToken', 'sessions'],
  },
)
