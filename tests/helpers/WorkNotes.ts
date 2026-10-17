import type { CollectionConfig } from 'payload'

import { withRbac } from '../../src/access/with-rbac'
import { BRANCHES_SLUG, DATA_CLASSES_SLUG, ORGANIZATIONS_SLUG } from '../../src/scope/constants'

export const WORK_NOTES_SLUG = 'work-notes'
export const WORK_NOTE_ORGANIZATION_FIELD = 'ownerOrganization'
export const WORK_NOTE_BRANCH_FIELD = 'ownerBranch'
export const WORK_NOTE_DATA_CLASS_FIELD = 'ownerClass'

/**
 * Registered only from Vitest setup. Not part of the production config, the
 * generated types, or the migrations. Field names differ from records so the
 * row filter cannot assume one table.
 */
export const WorkNotes: CollectionConfig = withRbac(
  {
    slug: WORK_NOTES_SLUG,
    admin: { hidden: true },
    fields: [
      {
        name: 'title',
        type: 'text',
        required: true,
      },
      {
        name: WORK_NOTE_ORGANIZATION_FIELD,
        type: 'relationship',
        relationTo: ORGANIZATIONS_SLUG,
        required: true,
      },
      {
        name: WORK_NOTE_BRANCH_FIELD,
        type: 'relationship',
        relationTo: BRANCHES_SLUG,
        required: true,
      },
      {
        name: WORK_NOTE_DATA_CLASS_FIELD,
        type: 'relationship',
        relationTo: DATA_CLASSES_SLUG,
        required: true,
      },
    ],
  },
  {
    rowScope: {
      organizationField: WORK_NOTE_ORGANIZATION_FIELD,
      branchField: WORK_NOTE_BRANCH_FIELD,
      dataClassField: WORK_NOTE_DATA_CLASS_FIELD,
    },
  },
)
