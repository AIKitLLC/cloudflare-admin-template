// Variant (a): one real Payload collection per object definition, built at plugin init.
import type { CollectionConfig, Field } from 'payload'

import { withRbac } from '../../src/access'
import { withAuditTrail } from '../../src/audit'
import { standardSlug, type FieldDefinition, type ObjectDefinition } from './definitions'

function toPayloadField(field: FieldDefinition): Field {
  const base = { name: field.key, label: field.label, required: field.required }
  switch (field.type) {
    case 'select':
      return { ...base, type: 'select', options: field.options ?? [] }
    case 'relation':
      return { ...base, type: 'relationship', relationTo: field.relationTo as 'users' }
    case 'email':
      return { ...base, type: 'email' }
    case 'number':
      return { ...base, type: 'number' }
    case 'date':
      return { ...base, type: 'date' }
    case 'checkbox':
      return { ...base, type: 'checkbox' }
    default:
      return { ...base, type: 'text' }
  }
}

export function collectionFromDefinition(definition: ObjectDefinition): CollectionConfig {
  return withAuditTrail(
    withRbac({
      slug: standardSlug(definition),
      labels: { singular: definition.singular, plural: `${definition.singular}s` },
      admin: { group: 'Nexus CRM', useAsTitle: definition.titleField },
      fields: [
        ...definition.fields.map(toPayloadField),
        { name: 'owner', type: 'relationship', relationTo: 'users' },
      ],
    }),
  )
}
