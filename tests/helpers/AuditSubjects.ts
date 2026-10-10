import type { CollectionConfig } from 'payload'

import { withAuditTrail } from '../../src/audit/hooks/withAuditTrail'

const wideFields = Array.from({ length: 20 }, (_, index) => ({
  name: `field${String(index + 1).padStart(2, '0')}`,
  type: 'text' as const,
}))

/**
 * Registered only from Vitest setup. Not part of the production config or the
 * generated Payload types. Exercises bulk writes, relationship diffs, and wide
 * updates without adding a production table.
 */
export const AuditSubjects: CollectionConfig = withAuditTrail({
  slug: 'audit-subjects',
  admin: { hidden: true },
  access: {
    create: () => true,
    delete: () => true,
    read: () => true,
    update: () => true,
  },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'note', type: 'text' },
    { name: 'failNext', type: 'checkbox' },
    { name: 'owner', type: 'relationship', relationTo: 'users' },
    { name: 'watchers', type: 'relationship', relationTo: 'users', hasMany: true },
    { name: 'pointer', type: 'relationship', relationTo: ['users', 'media'] },
    ...wideFields,
  ],
  hooks: {
    beforeChange: [
      ({ data }) => {
        if (data?.failNext === true) {
          throw new Error('intentional audit subject failure')
        }
        return data
      },
    ],
  },
})
