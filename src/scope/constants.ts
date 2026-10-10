export const ORGANIZATIONS_SLUG = 'organizations'
export const BRANCHES_SLUG = 'branches'
export const DATA_CLASSES_SLUG = 'data-classes'
export const RECORDS_SLUG = 'records'
export const WORK_NOTES_SLUG = 'work-notes'

export const USER_ORGANIZATIONS_FIELD = 'organizations'
export const USER_BRANCHES_FIELD = 'branches'
export const USER_DATA_CLASSES_FIELD = 'dataClasses'

export const SCOPE_PARENT_FIELD = 'parent'
export const SCOPE_PATH_FIELD = 'scopePath'
export const BRANCH_ORGANIZATION_FIELD = 'organization'
export const RECORD_BRANCH_FIELD = 'branch'
export const RECORD_DATA_CLASS_FIELD = 'dataClass'
export const WORK_NOTE_ORGANIZATION_FIELD = 'ownerOrganization'
export const WORK_NOTE_BRANCH_FIELD = 'ownerBranch'
export const WORK_NOTE_DATA_CLASS_FIELD = 'ownerClass'

/**
 * D1 rejects a statement with more than 100 bound parameters.
 * Page reads stay under that cap, including the id list Payload binds when it hydrates a page.
 */
export const D1_SAFE_PAGE_SIZE = 80

/**
 * Collapsed direct assignments kept on one relationship.
 * Reads bind nothing per assignment, but a larger set is rejected at save time
 * so a caller cannot attach an unbounded list.
 */
export const MAX_DIRECT_ASSIGNMENTS = 80

/**
 * Document `id IN` lists are inlined, but a relationship `in` binds about two
 * parameters per id. Keep each access `in` list at or below this size.
 */
export const ID_IN_CHUNK = 40

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
