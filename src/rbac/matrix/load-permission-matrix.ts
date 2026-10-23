import type { CollectionSlug, Payload } from 'payload'

import { PERMISSIONS_SLUG, ROLE_PERMISSIONS_SLUG, ROLES_SLUG } from '../../access'
import { relationId } from '../../access'
import type { MatrixGroup, MatrixRole, PermissionMatrix } from './matrix-types'

const ACTION_ORDER = ['create', 'read', 'update', 'delete', 'export', 'readField', 'writeField']

type PermissionDoc = {
  id: number | string
  key?: string | null
  label?: string | null
  collectionSlug?: string | null
  action?: string | null
  fieldPath?: string | null
  active?: boolean | null
}

type RoleDoc = {
  id: number | string
  name?: string | null
  slug?: string | null
  grantsFullAccess?: boolean | null
}

export async function loadPermissionMatrix(payload: Payload): Promise<PermissionMatrix> {
  const [roles, permissions, grants] = await Promise.all([
    payload.find({
      collection: ROLES_SLUG as CollectionSlug,
      depth: 0,
      overrideAccess: true,
      pagination: false,
      sort: 'name',
    }),
    payload.find({
      collection: PERMISSIONS_SLUG as CollectionSlug,
      depth: 0,
      overrideAccess: true,
      pagination: false,
      where: {
        active: {
          equals: true,
        },
      },
    }),
    payload.find({
      collection: ROLE_PERMISSIONS_SLUG as CollectionSlug,
      depth: 0,
      overrideAccess: true,
      pagination: false,
      where: {
        granted: {
          equals: true,
        },
      },
    }),
  ])

  const matrixRoles: MatrixRole[] = (roles.docs as RoleDoc[]).map((role) => ({
    id: Number(role.id),
    name: role.name || role.slug || String(role.id),
    slug: role.slug || '',
    grantsFullAccess: Boolean(role.grantsFullAccess),
  }))

  const grantedPairs = new Set(
    (grants.docs as { role?: unknown; permission?: unknown }[]).flatMap((grant) => {
      const roleId = relationId(grant.role)
      const permissionId = relationId(grant.permission)
      return roleId && permissionId ? [`${roleId}:${permissionId}`] : []
    }),
  )

  const groups = new Map<string, MatrixGroup>()
  const orderedPermissions = [...(permissions.docs as PermissionDoc[])].sort(comparePermissions)
  for (const permission of orderedPermissions) {
    const collectionSlug = permission.collectionSlug || 'unknown'
    const group = groups.get(collectionSlug) ?? {
      collectionSlug,
      label: groupLabel(payload, collectionSlug),
      rows: [],
    }
    const grantsByRoleId: Record<string, boolean> = {}
    for (const role of matrixRoles) {
      grantsByRoleId[String(role.id)] =
        role.grantsFullAccess || grantedPairs.has(`${role.id}:${permission.id}`)
    }
    group.rows.push({
      permissionId: Number(permission.id),
      key: permission.key || '',
      label: permission.label || permission.key || '',
      action: permission.action || '',
      fieldPath: permission.fieldPath || null,
      grantsByRoleId,
    })
    groups.set(collectionSlug, group)
  }

  return {
    roles: matrixRoles,
    groups: [...groups.values()],
  }
}

function groupLabel(payload: Payload, collectionSlug: string): string {
  const collection = payload.config.collections.find((item) => item.slug === collectionSlug)
  const singular = collection?.labels?.singular
  if (typeof singular === 'string' && singular.trim()) {
    return singular
  }
  return collectionSlug
}

function comparePermissions(left: PermissionDoc, right: PermissionDoc): number {
  const leftField = left.fieldPath ? 1 : 0
  const rightField = right.fieldPath ? 1 : 0
  if (leftField !== rightField) {
    return leftField - rightField
  }
  const leftAction = ACTION_ORDER.indexOf(left.action || '')
  const rightAction = ACTION_ORDER.indexOf(right.action || '')
  if (leftAction !== rightAction) {
    return leftAction - rightAction
  }
  return (left.fieldPath || '').localeCompare(right.fieldPath || '')
}
