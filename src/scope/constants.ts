export const ORGANIZATIONS_SLUG = 'organizations'
export const BRANCHES_SLUG = 'branches'
export const DATA_CLASSES_SLUG = 'data-classes'
export const RECORDS_SLUG = 'records'

export const USER_ORGANIZATIONS_FIELD = 'organizations'
export const USER_BRANCHES_FIELD = 'branches'
export const USER_DATA_CLASSES_FIELD = 'dataClasses'

export const SCOPE_PARENT_FIELD = 'parent'
export const BRANCH_ORGANIZATION_FIELD = 'organization'
export const RECORD_BRANCH_FIELD = 'branch'
export const RECORD_DATA_CLASS_FIELD = 'dataClass'

export const MAX_SCOPE_DEPTH = 32

export const SCOPE_CATALOG_CACHE_KEY = 'rowScopeCatalog'
export const EFFECTIVE_SCOPE_CACHE_KEY = 'rowScopeEffective'
export const VISIBLE_USERS_CACHE_KEY = 'rowScopeVisibleUsers'

export const USER_SCOPE_FIELDS = [
  USER_ORGANIZATIONS_FIELD,
  USER_BRANCHES_FIELD,
  USER_DATA_CLASSES_FIELD,
] as const

export type UserScopeField = (typeof USER_SCOPE_FIELDS)[number]
