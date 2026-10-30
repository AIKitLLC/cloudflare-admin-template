import type { loadUserGrants } from '../access'
import { registerCatalogContributor, type PermissionDefinition } from '../rbac'
import type { NexusRole } from './bridge-identity'

type UserGrants = Awaited<ReturnType<typeof loadUserGrants>>

export const NEXUS_PERMISSION_KEYS = {
  read: 'nexus:read',
  write: 'nexus:write',
  admin: 'nexus:admin',
} as const

const definitions = (): PermissionDefinition[] => [
  {
    key: NEXUS_PERMISSION_KEYS.read,
    label: 'Nexus CRM · Read',
    groupLabel: 'Nexus CRM',
    collectionSlug: 'nexus',
    action: 'read',
  },
  {
    key: NEXUS_PERMISSION_KEYS.write,
    label: 'Nexus CRM · Create and edit',
    groupLabel: 'Nexus CRM',
    collectionSlug: 'nexus',
    action: 'update',
  },
  {
    key: NEXUS_PERMISSION_KEYS.admin,
    label: 'Nexus CRM · Administer',
    groupLabel: 'Nexus CRM',
    collectionSlug: 'nexus',
    action: 'update',
  },
]

/** Adds the Nexus keys to the permission catalog. Called only when the `NEXUS` binding exists. */
export function registerNexusPermissions(): void {
  registerCatalogContributor({ definitions })
}

/**
 * The Nexus role for a template user, or null for no access. Full access is the Nexus owner;
 * otherwise the strongest Nexus key wins.
 */
export function nexusRoleFor(grants: UserGrants | null | undefined): NexusRole | null {
  if (!grants) return null
  if (grants.fullAccess) return 'owner'
  if (grants.permissionKeys.has(NEXUS_PERMISSION_KEYS.admin)) return 'admin'
  if (grants.permissionKeys.has(NEXUS_PERMISSION_KEYS.write)) return 'member'
  if (grants.permissionKeys.has(NEXUS_PERMISSION_KEYS.read)) return 'viewer'
  return null
}
