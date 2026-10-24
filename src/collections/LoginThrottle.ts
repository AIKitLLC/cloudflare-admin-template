import { APIError, type CollectionConfig } from 'payload'

import { LOGIN_THROTTLE_SLUG } from '../auth'

/** Per-IP sign-in counters. Payload owns the schema; `src/auth/login-throttle.ts` owns writes. */
export const LoginThrottle: CollectionConfig = {
  slug: LOGIN_THROTTLE_SLUG,
  timestamps: false,
  lockDocuments: false,
  admin: { hidden: true },
  custom: { rbac: { ownsAccess: true } },
  access: {
    read: () => false,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  hooks: {
    beforeOperation: [
      ({ operation }) => {
        if (['create', 'update', 'delete'].includes(operation)) {
          throw new APIError('Login throttle rows are managed by the login hook', 403)
        }
      },
    ],
  },
  fields: [
    { name: 'bucketKey', type: 'text', required: true, unique: true },
    { name: 'used', type: 'number', required: true },
    { name: 'resetAt', type: 'number', required: true },
  ],
}
