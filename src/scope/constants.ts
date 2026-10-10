export const ORGANIZATIONS_SLUG = 'organizations'
export const BRANCHES_SLUG = 'branches'
export const DATA_CLASSES_SLUG = 'data-classes'
export const RECORDS_SLUG = 'records'

export const USER_ORGANIZATIONS_FIELD = 'organizations'
export const USER_BRANCHES_FIELD = 'branches'
export const USER_DATA_CLASSES_FIELD = 'dataClasses'

export const SCOPE_PARENT_FIELD = 'parent'
export const SCOPE_PATH_FIELD = 'scopePath'
export const BRANCH_ORGANIZATION_FIELD = 'organization'
export const RECORD_BRANCH_FIELD = 'branch'
export const RECORD_DATA_CLASS_FIELD = 'dataClass'

/**
 * D1 rejects a statement with more than 100 bound parameters.
 * Page reads stay under that cap, including the id list Payload binds when it hydrates a page.
 */
export const D1_SAFE_PAGE_SIZE = 80

/**
 * Collapsed direct assignments across organizations, branches, and data classes.
 * D1 allows 64 tables in a join. A record filter joins the organization once per
 * assigned organization and again, with the branch, for `branch.organization`,
 * so one organization assignment costs three joins. 20 keeps that worst case at
 * 60 joins, under the 64-table cap, with room for the caller's where. The same
 * filter stays under 100 bound parameters and under the expression depth of 100.
 */
export const MAX_DIRECT_ASSIGNMENTS = 20

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
