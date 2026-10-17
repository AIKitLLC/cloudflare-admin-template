import type { CollectionBeforeChangeHook, CollectionConfig, PayloadRequest } from 'payload'

import { withRbac } from '../../access/with-rbac'
import {
  invalidateSystemParameterCache,
  invalidateSystemParameterCacheOnDelete,
} from '../cache/invalidate-on-change'
import {
  previewSystemParameterAudit,
  recordSystemParameterAudit,
  recordSystemParameterDeletion,
} from '../hooks/record-audit'
import { AUDIT_REDACT_WHEN_SENSITIVE, SYSTEM_PARAMETERS_SLUG } from '../constants'
import { guardSystemParameterExport, refuseValueQuery } from '../query/refuse-value-query'
import { maskSensitiveParameterOnRead } from '../sensitive/mask-on-read'
import { guardSensitiveUnmask } from '../sensitive/guard-unmask'
import { prepareSystemParameterWrite } from '../sensitive/prepare-write'
import type { ParameterWriteData } from '../types'
import {
  validateParameterCategory,
  validateParameterKey,
  validateParameterValueField,
} from '../validation/field-validators'

const prepareSystemParameter: CollectionBeforeChangeHook = ({ data, operation, originalDoc }) => {
  prepareSystemParameterWrite({
    data: data as ParameterWriteData,
    originalDoc: originalDoc as ParameterWriteData | undefined,
    operation,
  })
  return data
}

export const SystemParameters: CollectionConfig = withRbac({
  slug: SYSTEM_PARAMETERS_SLUG,
  labels: {
    singular: 'System Parameter',
    plural: 'System Parameters',
  },
  admin: {
    useAsTitle: 'key',
    group: 'System',
    description:
      'Runtime configuration. Credentials belong in Worker secrets. Mark a value sensitive to hide it from the API, export, and audit diffs.',
    defaultColumns: ['key', 'category', 'valueType', 'sensitive', 'updatedAt'],
  },
  fields: [
    {
      name: 'key',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      validate: (value: unknown, options: { id?: unknown; req?: PayloadRequest }) =>
        validateParameterKey(value, { id: options.id, req: options.req }),
      admin: {
        description:
          'Stable lowercase kebab-case id, for example maintenance-mode. Secret-like keys are rejected.',
      },
    },
    {
      name: 'category',
      type: 'text',
      required: true,
      index: true,
      validate: (value: unknown) => validateParameterCategory(value),
      admin: {
        description: 'Group slug, for example billing, features, or operations.',
      },
    },
    {
      name: 'label',
      type: 'text',
    },
    {
      name: 'description',
      type: 'textarea',
    },
    {
      name: 'valueType',
      type: 'select',
      required: true,
      options: [
        { label: 'String', value: 'string' },
        { label: 'Number', value: 'number' },
        { label: 'Boolean', value: 'boolean' },
        { label: 'JSON', value: 'json' },
      ],
    },
    {
      name: 'value',
      type: 'json',
      required: true,
      custom: {
        audit: {
          redact: AUDIT_REDACT_WHEN_SENSITIVE,
        },
      },
      hooks: {
        beforeValidate: [
          async ({ operation, originalDoc, overrideAccess, req, siblingData }) => {
            await guardSensitiveUnmask({
              operation: operation ?? '',
              originalDoc: originalDoc as ParameterWriteData | undefined,
              overrideAccess: Boolean(overrideAccess),
              req,
              siblingData: (siblingData ?? {}) as ParameterWriteData,
            })
          },
        ],
      },
      validate: (value, options) =>
        validateParameterValueField(value, {
          siblingData: options.siblingData as { valueType?: unknown },
          jsonError: options.jsonError,
        }),
      admin: {
        description:
          'Must match the declared type. JSON values must be an object or array. 0, false, and empty strings are valid for their types.',
      },
    },
    {
      name: 'sensitive',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description:
          'Hides the value on read, list, export, and audit diffs. getParameter still returns it on the server. Do not use this for credentials.',
      },
    },
  ],
  endpoints: [
    {
      path: '/export',
      method: 'get',
      handler: (req) => guardSystemParameterExport(req),
    },
  ],
  hooks: {
    beforeOperation: [refuseValueQuery],
    beforeChange: [prepareSystemParameter, previewSystemParameterAudit],
    afterRead: [maskSensitiveParameterOnRead],
    afterChange: [invalidateSystemParameterCache, recordSystemParameterAudit],
    afterDelete: [invalidateSystemParameterCacheOnDelete, recordSystemParameterDeletion],
  },
  versions: false,
})
