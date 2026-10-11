import type { TextField } from 'payload'

import { SCOPE_PATH_FIELD } from '../constants'

export function scopePathField(): TextField {
  return {
    name: SCOPE_PATH_FIELD,
    type: 'text',
    index: true,
    access: {
      // Access Wheres name this column. Query validation requires field read,
      // and a permission key would hide it from roles that were not granted it.
      // Writes stay closed; syncScopePath updates the value with overrideAccess.
      read: () => true,
      create: () => false,
      update: () => false,
    },
    admin: {
      readOnly: true,
      position: 'sidebar',
      description:
        'Ancestor path, including this node. Reads match this column instead of a list of descendant ids.',
    },
  }
}
