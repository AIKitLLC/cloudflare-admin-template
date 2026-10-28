// Variant (b): one universal record collection, data kept as JSON. Mirrors the nexus `records` table.
import type { CollectionBeforeValidateHook, CollectionConfig, PayloadRequest } from 'payload'

import { withRbac } from '../../src/access'
import { withAuditTrail } from '../../src/audit'
import type { ObjectDefinition } from './definitions'

export const NEXUS_RECORDS_SLUG = 'nexus_records'

// Every rule Payload gives a real field for free has to be rewritten here, per object definition.
export type DefinitionResolver = (req: PayloadRequest) => Promise<ObjectDefinition[]> | ObjectDefinition[]

export function validateAgainst(definitions: DefinitionResolver): CollectionBeforeValidateHook {
  return async ({ data, req }) => {
    const definition = (await definitions(req)).find((item) => item.key === data?.objectKey)
    if (!definition) {
      throw new Error(`Unknown object type: ${String(data?.objectKey)}`)
    }
    const values = (data?.data ?? {}) as Record<string, unknown>
    for (const field of definition.fields) {
      if (field.required && (values[field.key] === undefined || values[field.key] === '')) {
        throw new Error(`${definition.singular}.${field.key} is required`)
      }
      if (field.type === 'select' && values[field.key] !== undefined) {
        if (!field.options?.includes(String(values[field.key]))) {
          throw new Error(`${definition.singular}.${field.key} must be one of ${field.options?.join(', ')}`)
        }
      }
    }
    return {
      ...data,
      title: String(values[definition.titleField] ?? data?.title ?? ''),
      searchText: Object.values(values).join(' ').toLowerCase(),
    }
  }
}

export function universalRecords(definitions: DefinitionResolver): CollectionConfig {
  return withAuditTrail(
    withRbac({
      slug: NEXUS_RECORDS_SLUG,
      labels: { singular: 'Nexus Record', plural: 'Nexus Records' },
      admin: { group: 'Nexus CRM', useAsTitle: 'title', defaultColumns: ['title', 'objectKey', 'status'] },
      hooks: { beforeValidate: [validateAgainst(definitions)] },
      fields: [
        { name: 'objectKey', type: 'text', required: true, index: true },
        { name: 'title', type: 'text', index: true },
        { name: 'status', type: 'text', defaultValue: 'active', index: true },
        { name: 'owner', type: 'relationship', relationTo: 'users' },
        { name: 'data', type: 'json' },
        { name: 'searchText', type: 'text', admin: { hidden: true } },
      ],
    }),
  )
}
