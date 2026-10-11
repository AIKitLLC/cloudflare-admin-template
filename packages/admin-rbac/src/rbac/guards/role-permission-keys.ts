import type { CollectionSlug, PayloadRequest } from 'payload'

import { PERMISSIONS_SLUG, ROLE_PERMISSIONS_SLUG } from '../../access/constants'
import { relationId } from '../../access/relation-id'

type PermissionRecord = {
  id?: number | string
  key?: string | null
  active?: boolean | null
}

export async function permissionKeysForIds(
  req: PayloadRequest,
  permissionIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(permissionIds)]
  const keys = new Map<string, string>()
  if (unique.length === 0) {
    return keys
  }
  const permissions = await req.payload.find({
    collection: PERMISSIONS_SLUG as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      id: {
        in: unique,
      },
    },
  })
  for (const permission of permissions.docs) {
    const record = permission as PermissionRecord
    if (record.id === undefined || record.id === null || !record.key) {
      continue
    }
    keys.set(String(record.id), record.key)
  }
  return keys
}

export async function grantedKeysByRole(
  req: PayloadRequest,
  roleIds: string[],
): Promise<Map<string, Set<string>>> {
  const keysByRole = new Map(roleIds.map((roleId) => [roleId, new Set<string>()]))
  if (roleIds.length === 0) {
    return keysByRole
  }
  const grants = await req.payload.find({
    collection: ROLE_PERMISSIONS_SLUG as CollectionSlug,
    depth: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      and: [
        {
          role: {
            in: roleIds,
          },
        },
        {
          granted: {
            equals: true,
          },
        },
      ],
    },
  })

  const unresolved = new Map<string, string[]>()
  for (const grant of grants.docs) {
    const roleId = relationId((grant as { role?: unknown }).role)
    if (!roleId || !keysByRole.has(roleId)) {
      continue
    }
    const permission = (grant as { permission?: unknown }).permission
    const populated = permissionKey(permission)
    if (populated) {
      keysByRole.get(roleId)?.add(populated)
      continue
    }
    const permissionId = relationId(permission)
    if (!permissionId) {
      continue
    }
    const pending = unresolved.get(permissionId) ?? []
    pending.push(roleId)
    unresolved.set(permissionId, pending)
  }

  if (unresolved.size > 0) {
    const keys = await permissionKeysForIds(req, [...unresolved.keys()])
    const active = await activePermissionIds(req, [...unresolved.keys()])
    for (const [permissionId, holders] of unresolved) {
      const key = keys.get(permissionId)
      if (!key || !active.has(permissionId)) {
        continue
      }
      for (const roleId of holders) {
        keysByRole.get(roleId)?.add(key)
      }
    }
  }

  return keysByRole
}

function permissionKey(permission: unknown): string | undefined {
  if (!permission || typeof permission !== 'object') {
    return undefined
  }
  const record = permission as PermissionRecord
  if (record.active === false || !record.key) {
    return undefined
  }
  return record.key
}

async function activePermissionIds(
  req: PayloadRequest,
  permissionIds: string[],
): Promise<Set<string>> {
  const permissions = await req.payload.find({
    collection: PERMISSIONS_SLUG as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      and: [
        {
          id: {
            in: permissionIds,
          },
        },
        {
          active: {
            equals: true,
          },
        },
      ],
    },
  })
  return new Set(permissions.docs.map((permission) => String(permission.id)))
}
