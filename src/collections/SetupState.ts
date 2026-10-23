import { APIError, type CollectionConfig } from 'payload'

import { SETUP_STATE_SLUG } from '../auth/first-admin-setup'

/**
 * First-run admin setup state: one row, keyed by a unique `singleton` value. Payload owns
 * the schema; `src/auth/first-admin-setup.ts` owns writes.
 */
export const SetupState: CollectionConfig = {
  slug: SETUP_STATE_SLUG,
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
          throw new APIError('Setup state is managed by the first-run admin setup', 403)
        }
      },
    ],
  },
  fields: [
    { name: 'singleton', type: 'text', required: true, unique: true },
    { name: 'claimToken', type: 'text' },
    { name: 'claimedAt', type: 'number' },
    { name: 'completedAt', type: 'number' },
  ],
}
