// THROWAWAY spike for #44. Not for merge. Nexus-style object definitions, trimmed to contacts + deals.
// `workspace_id` is dropped: one workspace per install (Tony, 2026-10-26).

export type FieldDefinition = {
  key: string
  label: string
  type: 'text' | 'email' | 'number' | 'date' | 'checkbox' | 'select' | 'relation'
  required?: boolean
  options?: string[]
  relationTo?: string
}

export type ObjectDefinition = {
  key: string
  singular: string
  plural: string
  titleField: string
  fields: FieldDefinition[]
}

export const contactDefinition: ObjectDefinition = {
  key: 'contact',
  singular: 'Contact',
  plural: 'contacts',
  titleField: 'name',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'text' },
    {
      key: 'lifecycle',
      label: 'Lifecycle',
      type: 'select',
      options: ['lead', 'customer', 'dormant'],
    },
    { key: 'doNotContact', label: 'Do not contact', type: 'checkbox' },
  ],
}

export const dealDefinition: ObjectDefinition = {
  key: 'deal',
  singular: 'Deal',
  plural: 'deals',
  titleField: 'title',
  fields: [
    { key: 'title', label: 'Title', type: 'text', required: true },
    { key: 'amount', label: 'Amount', type: 'number' },
    {
      key: 'stage',
      label: 'Stage',
      type: 'select',
      required: true,
      options: ['new', 'qualified', 'proposal', 'won', 'lost'],
    },
    { key: 'expectedCloseDate', label: 'Expected close', type: 'date' },
    { key: 'contact', label: 'Contact', type: 'relation', relationTo: 'nexus_contacts' },
  ],
}

export const standardDefinitions = [contactDefinition, dealDefinition]

export const NEXUS_PREFIX = 'nexus_'
export const standardSlug = (definition: ObjectDefinition) => `${NEXUS_PREFIX}${definition.plural}`
