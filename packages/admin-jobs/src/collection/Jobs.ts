import { randomUUID } from 'crypto'
import type { CollectionConfig } from 'payload'

import { evaluateCollectionAccess } from '@aikit/admin-rbac'
import { withRbac } from '@aikit/admin-rbac'
import { evaluateJobDispatch } from '../auth/evaluate-job-dispatch'
import { JOB_STATUSES, JOBS_SLUG } from '../constants'
import { jobDataFieldAccess } from './job-field-access'
import { capJobQuery } from './hooks/cap-job-query'
import { enqueueAfterChange } from './hooks/enqueue-after-change'
import { prepareJobWrite } from './hooks/prepare-job-write'
import { redactJobRead } from './hooks/redact-job-read'
import { retryJobEndpoint } from '../endpoints/retry-endpoint'
import { triggerJobEndpoint } from '../endpoints/trigger-endpoint'
import { registerDispatchPermissions } from '../permissions/register-dispatch-permissions'
import '../registry/shipped-jobs'

registerDispatchPermissions()

export const Jobs: CollectionConfig = withRbac({
  slug: JOBS_SLUG,
  labels: {
    singular: 'Job',
    plural: 'Jobs',
  },
  admin: {
    useAsTitle: 'name',
    group: 'Operations',
    description: 'Background jobs. Trigger and retry from the job monitor. Payloads are redacted before they are stored.',
    defaultColumns: ['name', 'status', 'attempt', 'updatedAt'],
  },
  access: {
    create: ({ req }) => evaluateJobDispatch(req, 'trigger'),
    update: () => false,
    delete: () => false,
    read: ({ req }) => evaluateCollectionAccess({ req, collectionSlug: JOBS_SLUG, action: 'read' }),
  },
  endpoints: [triggerJobEndpoint, retryJobEndpoint],
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
      index: true,
      maxLength: 80,
      access: jobDataFieldAccess,
    },
    {
      name: 'payload',
      type: 'json',
      required: true,
      defaultValue: {},
      access: jobDataFieldAccess,
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'PENDING',
      index: true,
      options: JOB_STATUSES.map((status) => ({ label: status, value: status })),
      access: jobDataFieldAccess,
    },
    {
      name: 'error',
      type: 'textarea',
      access: jobDataFieldAccess,
    },
    {
      name: 'logs',
      type: 'json',
      defaultValue: [],
      access: jobDataFieldAccess,
    },
    {
      name: 'attempt',
      type: 'number',
      required: true,
      defaultValue: 0,
      min: 0,
      access: jobDataFieldAccess,
    },
    {
      name: 'maxAttempts',
      type: 'number',
      required: true,
      defaultValue: 5,
      min: 1,
      access: jobDataFieldAccess,
    },
    {
      name: 'runAt',
      type: 'date',
      index: true,
      access: jobDataFieldAccess,
    },
    {
      name: 'leaseExpiresAt',
      type: 'date',
      index: true,
      access: jobDataFieldAccess,
    },
    {
      name: 'startedAt',
      type: 'date',
      access: jobDataFieldAccess,
    },
    {
      name: 'finishedAt',
      type: 'date',
      access: jobDataFieldAccess,
    },
    {
      name: 'idempotencyKey',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      access: jobDataFieldAccess,
      hooks: {
        beforeValidate: [
          ({ value }) =>
            typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : randomUUID(),
        ],
      },
    },
    {
      name: 'claimToken',
      type: 'text',
      hidden: true,
      access: {
        create: () => false,
        read: () => false,
        update: () => false,
      },
    },
  ],
  hooks: {
    beforeOperation: [capJobQuery],
    beforeChange: [prepareJobWrite],
    afterRead: [redactJobRead],
    afterChange: [enqueueAfterChange],
  },
  lockDocuments: false,
})
