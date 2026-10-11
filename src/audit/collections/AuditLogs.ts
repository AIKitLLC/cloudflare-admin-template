import type { CollectionConfig } from 'payload'

import { auditLogAccess } from '../access/AuditLogAccessPolicy'
import { AUDIT_LOGS_SLUG } from '../constants'
import { rejectAuditLogDelete, rejectAuditLogUpdate } from '../hooks/rejectAuditLogMutation'
import { acceptAuditJsonValue } from './acceptAuditJsonValue'

/**
 * Append-only trail of collection changes.
 * Rows are created by audit hooks with `overrideAccess`. Admins can read and filter them.
 */
export const AuditLogs: CollectionConfig = {
  slug: AUDIT_LOGS_SLUG,
  labels: {
    singular: 'Audit Log',
    plural: 'Audit Logs',
  },
  admin: {
    group: 'System',
    useAsTitle: 'summary',
    defaultColumns: [
      'occurredAt',
      'action',
      'collectionSlug',
      'documentId',
      'actor',
      'ipAddress',
    ],
    description:
      'Append-only trail of who changed which field. Filter by record ID, collection, or operator. Records cannot be edited or deleted.',
    listSearchableFields: ['summary', 'documentId', 'collectionSlug', 'actorEmail', 'operatorId'],
    components: {
      beforeList: ['@/audit/admin/AuditLogFilterBar#AuditLogFilterBar'],
    },
  },
  access: auditLogAccess,
  defaultSort: '-occurredAt',
  disableBulkEdit: true,
  disableDuplicate: true,
  lockDocuments: false,
  timestamps: true,
  indexes: [
    {
      fields: ['collectionSlug', 'documentId'],
    },
  ],
  fields: [
    {
      name: 'summary',
      type: 'text',
      required: true,
      admin: {
        readOnly: true,
        description: 'Short description of the action and the fields that changed.',
      },
    },
    {
      name: 'action',
      type: 'select',
      required: true,
      index: true,
      options: [
        { label: 'Create', value: 'CREATE' },
        { label: 'Update', value: 'UPDATE' },
        { label: 'Delete', value: 'DELETE' },
      ],
      admin: { readOnly: true },
    },
    {
      name: 'collectionSlug',
      label: 'Collection',
      type: 'text',
      required: true,
      index: true,
      admin: {
        readOnly: true,
        description: 'Slug of the collection that changed.',
      },
    },
    {
      name: 'documentId',
      label: 'Record ID',
      type: 'text',
      required: true,
      index: true,
      admin: {
        readOnly: true,
        description: 'Id of the record that changed.',
      },
    },
    {
      name: 'actor',
      label: 'Operator',
      type: 'relationship',
      relationTo: 'users',
      index: true,
      admin: {
        readOnly: true,
        description:
          'Authenticated user who made the change. Cleared if that user is later deleted; the operator id and email snapshots remain.',
      },
    },
    {
      name: 'operatorId',
      label: 'Operator ID',
      type: 'text',
      index: true,
      admin: {
        readOnly: true,
        description:
          'Snapshot of the operator id. Kept after the user row is deleted. Stored separately from the operator relationship so the two columns cannot collide.',
      },
    },
    {
      name: 'actorEmail',
      label: 'Operator email',
      type: 'text',
      index: true,
      admin: {
        readOnly: true,
        description: 'Snapshot of the operator email at the time of the change.',
      },
    },
    {
      name: 'ipAddress',
      label: 'Client IP',
      type: 'text',
      admin: {
        readOnly: true,
        description: 'CF-Connecting-IP only. Forwarded headers are not stored here.',
      },
    },
    {
      name: 'untrustedClientIp',
      label: 'Untrusted client IP',
      type: 'text',
      admin: {
        readOnly: true,
        description:
          'First X-Forwarded-For hop, or X-Real-IP. Personal data. Anyone who can read audit logs can see it. Not authenticated. Do not treat this as the client.',
      },
    },
    {
      name: 'userAgent',
      label: 'User agent',
      type: 'textarea',
      admin: { readOnly: true },
    },
    {
      name: 'occurredAt',
      label: 'Timestamp',
      type: 'date',
      required: true,
      index: true,
      admin: {
        readOnly: true,
        date: {
          pickerAppearance: 'dayAndTime',
        },
      },
    },
    {
      name: 'changes',
      label: 'Field changes',
      type: 'array',
      admin: {
        readOnly: true,
        description: 'Old and new value of each changed field. Secrets are redacted.',
      },
      fields: [
        {
          name: 'path',
          label: 'Field',
          type: 'text',
          required: true,
          admin: { readOnly: true },
        },
        {
          name: 'oldValue',
          label: 'Old value',
          type: 'json',
          validate: acceptAuditJsonValue,
          admin: { readOnly: true },
        },
        {
          name: 'newValue',
          label: 'New value',
          type: 'json',
          validate: acceptAuditJsonValue,
          admin: { readOnly: true },
        },
      ],
    },
  ],
  hooks: {
    beforeChange: [rejectAuditLogUpdate],
    beforeDelete: [rejectAuditLogDelete],
  },
}
