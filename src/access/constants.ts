export const ROLES_SLUG = 'roles'
export const PERMISSIONS_SLUG = 'permissions'
export const ROLE_PERMISSIONS_SLUG = 'role-permissions'
export const USERS_SLUG = 'users'

export const SUPER_ADMIN_SLUG = 'super-admin'
export const SUPER_ADMIN_NAME = 'Super Admin'

export const COLLECTION_ACTIONS = ['create', 'read', 'update', 'delete', 'export'] as const

export const FIELD_ACTIONS = ['readField', 'writeField'] as const

export const PERMISSION_ACTIONS = [...COLLECTION_ACTIONS, ...FIELD_ACTIONS] as const

export const GRANT_CACHE_KEY = 'rbacUserGrants'

export const SYSTEM_FIELD_NAMES = new Set(['createdAt', 'updatedAt'])

export const INTERNAL_COLLECTION_PREFIX = 'payload-'
