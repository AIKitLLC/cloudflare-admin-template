import type { CollectionSlug, PayloadRequest } from 'payload'

import {
  GRANT_CACHE_KEY,
  PERMISSIONS_SLUG,
  ROLE_PERMISSIONS_SLUG,
  ROLES_SLUG,
  USERS_SLUG,
} from '../constants'
import { relationId, relationIds } from '../relation-id'
import type { UserGrants } from '../types'

type GrantCacheEntry = {
  userId: string
  promise: Promise<UserGrants>
}

type PermissionRecord = {
  key?: string | null
  active?: boolean | null
}

function readCache(req: PayloadRequest, userId: number | string): Promise<UserGrants> | undefined {
  const cached = req.context?.[GRANT_CACHE_KEY] as GrantCacheEntry | undefined
  if (cached && cached.userId === String(userId)) {
    return cached.promise
  }
  return undefined
}

function storeCache(
  req: PayloadRequest,
  userId: number | string,
  promise: Promise<UserGrants>,
): void {
  if (!req.context) {
    req.context = {}
  }
  req.context[GRANT_CACHE_KEY] = {
    userId: String(userId),
    promise,
  } satisfies GrantCacheEntry
}

function emptyGrants(userId: number | string): UserGrants {
  return {
    userId,
    fullAccess: false,
    permissionKeys: new Set(),
    roleIds: [],
  }
}

function roleIdsFromRequestUser(req: PayloadRequest): string[] | undefined {
  if (!req.user || !('roles' in req.user)) {
    return undefined
  }
  return relationIds((req.user as { roles?: unknown }).roles)
}

export async function loadUserGrants(req: PayloadRequest): Promise<UserGrants | undefined> {
  const userId = req.user?.id
  if (userId === undefined || userId === null) {
    return undefined
  }

  const cached = readCache(req, userId)
  if (cached) {
    return cached
  }

  const pending = resolveUserGrants(req, userId)
  storeCache(req, userId, pending)
  return pending
}

async function resolveUserGrants(
  req: PayloadRequest,
  userId: number | string,
): Promise<UserGrants> {
  const requestRoleIds = roleIdsFromRequestUser(req)
  let roleIds = requestRoleIds
  if (!roleIds) {
    let user: { id: number | string; roles?: unknown } | null = null
    try {
      user = (await req.payload.findByID({
        collection: USERS_SLUG,
        id: userId,
        depth: 0,
        overrideAccess: true,
        disableErrors: true,
        req,
      })) as { id: number | string; roles?: unknown } | null
    } catch {
      user = null
    }
    if (!user) {
      return emptyGrants(userId)
    }
    roleIds = relationIds(user.roles)
  }

  if (roleIds.length === 0) {
    return emptyGrants(userId)
  }

  const roles = await req.payload.find({
    collection: ROLES_SLUG as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      id: {
        in: roleIds,
      },
    },
  })

  const fullAccess = roles.docs.some((role) =>
    Boolean((role as { grantsFullAccess?: boolean | null }).grantsFullAccess),
  )
  if (fullAccess) {
    return {
      userId,
      fullAccess: true,
      permissionKeys: new Set(),
      roleIds,
    }
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

  const permissionIds = grants.docs
    .map((grant) => relationId((grant as { permission?: unknown }).permission))
    .filter((id): id is string => Boolean(id))

  const keys = new Set<string>()
  const populatedKeys = grants.docs.flatMap((grant) => {
    const permission = (grant as { permission?: unknown }).permission
    if (!permission || typeof permission !== 'object') {
      return []
    }
    const record = permission as PermissionRecord
    if (record.active === false || !record.key) {
      return []
    }
    return [record.key]
  })

  if (populatedKeys.length > 0) {
    for (const key of populatedKeys) {
      keys.add(key)
    }
  } else if (permissionIds.length > 0) {
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
    for (const permission of permissions.docs) {
      const key = (permission as { key?: string | null }).key
      if (key) {
        keys.add(key)
      }
    }
  }

  return {
    userId,
    fullAccess: false,
    permissionKeys: keys,
    roleIds,
  }
}

export async function userGrantsFullAccess(req: PayloadRequest): Promise<boolean> {
  const grants = await loadUserGrants(req)
  return grants?.fullAccess === true
}
