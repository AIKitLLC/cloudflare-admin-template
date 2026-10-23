import { APIError, type CollectionConfig } from 'payload'

import { isClientSecurityOwner } from '../auth'

/** Payload owns the table schema; the reviewed CAS adapter owns all writes. */
const protectedTable = (slug: string, fields: CollectionConfig['fields']): CollectionConfig => ({
  slug,
  timestamps: false,
  admin: { hidden: true },
  // Access below is owner-only and writes go through the store, so RBAC coverage skips it.
  custom: { rbac: { ownsAccess: true } },
  access: {
    read: ({ req }) => isClientSecurityOwner(req.user),
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  hooks: {
    beforeOperation: [
      ({ operation }) => {
        if (['create', 'update', 'delete'].includes(operation)) {
          throw new APIError('Use the reviewed client security controls', 403)
        }
      },
    ],
  },
  fields,
})

export const ClientSecurityCollections: CollectionConfig[] = [
  protectedTable('client-security-state', [
    { name: 'revision', type: 'number', required: true },
    { name: 'commitNonce', type: 'text' },
    { name: 'admissionNonce', type: 'text' },
    { name: 'admissionAllowed', type: 'number' },
  ]),
  protectedTable('client-security-versions', [
    { name: 'revision', type: 'number', required: true, unique: true },
    { name: 'configuration', type: 'json', required: true },
    { name: 'digest', type: 'text', required: true },
    { name: 'actor', type: 'text', required: true },
    { name: 'operation', type: 'text', required: true },
    { name: 'createdAt', type: 'text', required: true },
  ]),
  protectedTable('client-security-counters', [
    { name: 'bucketKey', type: 'text', required: true, unique: true },
    { name: 'used', type: 'number', required: true },
    { name: 'resetAt', type: 'number', required: true },
  ]),
  protectedTable('client-security-audit', [
    { name: 'revision', type: 'number', required: true },
    { name: 'previousRevision', type: 'number', required: true },
    { name: 'actor', type: 'text', required: true },
    { name: 'operation', type: 'text', required: true },
    { name: 'createdAt', type: 'text', required: true },
  ]),
]
