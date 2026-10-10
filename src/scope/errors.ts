export const SELF_SCOPE_ASSIGNMENT_ERROR = 'You cannot change your own scope assignments.'

export const SCOPE_ASSIGNMENT_ERROR = 'You can only assign scopes within your own scope.'

export const SCOPE_ROLE_TARGET_ERROR = 'You can only assign roles to users inside your scope.'

export const SCOPE_USER_ERROR = 'You can only change a user inside your scope.'

export const SCOPE_TARGET_KEYS_ERROR =
  'You can only assign scope to a user whose permissions are within your own.'

export const SCOPE_NODE_IN_USE_ERROR =
  'Remove nested scope nodes, records, and user assignments that still use this scope before deleting it.'

export const SCOPE_GRANT_ERROR = 'You can only grant permissions to roles held inside your scope.'

export const SCOPE_RECORD_ERROR = 'You cannot set a scope outside your own.'

export const SCOPE_RECORD_MISMATCH_ERROR = 'The branch must belong to the record organization.'

export const SCOPE_NODE_ERROR = 'You cannot create or move a scope outside your own.'

export const SCOPE_BRANCH_ORG_ERROR = 'A branch must stay in its organization.'

export const SCOPE_CYCLE_ERROR =
  'That scope parent would create a cycle or exceed the hierarchy depth.'
