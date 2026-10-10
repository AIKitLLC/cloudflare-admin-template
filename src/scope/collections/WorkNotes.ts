import type { CollectionConfig } from 'payload'

import { withRbac } from '../../access/with-rbac'
import {
  BRANCHES_SLUG,
  DATA_CLASSES_SLUG,
  ORGANIZATIONS_SLUG,
  WORK_NOTE_BRANCH_FIELD,
  WORK_NOTE_DATA_CLASS_FIELD,
  WORK_NOTE_ORGANIZATION_FIELD,
  WORK_NOTES_SLUG,
} from '../constants'

export const WorkNotes: CollectionConfig = withRbac(
  {
    slug: WORK_NOTES_SLUG,
    labels: {
      singular: 'Work note',
      plural: 'Work notes',
    },
    admin: {
      useAsTitle: 'title',
      group: 'Organization',
      description:
        'A second scoped collection. Field names differ from records so the row filter cannot assume one table.',
      defaultColumns: ['title', WORK_NOTE_ORGANIZATION_FIELD, WORK_NOTE_BRANCH_FIELD],
    },
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
        index: true,
      },
      {
        name: WORK_NOTE_BRANCH_FIELD,
        type: 'relationship',
        relationTo: BRANCHES_SLUG,
        required: true,
        index: true,
      },
      {
        name: WORK_NOTE_DATA_CLASS_FIELD,
        type: 'relationship',
        relationTo: DATA_CLASSES_SLUG,
        required: true,
        index: true,
      },
    ],
    graphQL: {
      singularName: 'WorkNote',
      pluralName: 'WorkNotes',
    },
  },
  {
    rowScope: {
      organizationField: WORK_NOTE_ORGANIZATION_FIELD,
      branchField: WORK_NOTE_BRANCH_FIELD,
      dataClassField: WORK_NOTE_DATA_CLASS_FIELD,
    },
  },
)
