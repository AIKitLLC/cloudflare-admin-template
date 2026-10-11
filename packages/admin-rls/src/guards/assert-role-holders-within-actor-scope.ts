import type { CollectionSlug, PayloadRequest } from 'payload'
import { APIError } from 'payload'

import { USERS_SLUG } from '@aikit/admin-rbac'
import { userGrantsFullAccess } from '@aikit/admin-rbac'
import { relationIds } from '@aikit/admin-rbac'
import { fullAccessRoleIds } from '@aikit/admin-rbac'
import { skipsPrivilegeChecks } from '@aikit/admin-rbac'
import { SCOPE_GRANT_ERROR } from '../errors'
import { assignmentsFromRecord } from '../resolve/assignments-from-record'
import { loadEffectiveScope } from '../resolve/load-effective-scope'
import { loadScopeCatalog } from '../resolve/load-scope-catalog'
import { resolveEffectiveScope } from '../resolve/resolve-effective-scope'
import { isScopeWithin } from './is-scope-within'

export async function assertRoleHoldersWithinActorScope(args: {
  req: PayloadRequest
  roleId: number | string
}): Promise<void> {
  if (skipsPrivilegeChecks(args.req.context) || !args.req.user) {
    return
  }
  if (await userGrantsFullAccess(args.req)) {
    return
  }

  const [actorScope, privilegedRoles, holders] = await Promise.all([
    loadEffectiveScope(args.req),
    fullAccessRoleIds(args.req),
    args.req.payload.find({
      collection: USERS_SLUG as CollectionSlug,
      depth: 0,
      overrideAccess: true,
      pagination: false,
      req: args.req,
      where: {
        roles: {
          equals: args.roleId,
        },
      },
    }),
  ])
  if (holders.docs.length === 0) {
    return
  }

  const catalog = await loadScopeCatalog(args.req)
  for (const holder of holders.docs) {
    const roles = relationIds((holder as { roles?: unknown }).roles)
    if (roles.some((roleId) => privilegedRoles.has(roleId))) {
      continue
    }
    const holderScope = resolveEffectiveScope(catalog, assignmentsFromRecord(holder))
    if (!isScopeWithin(holderScope, actorScope)) {
      throw new APIError(SCOPE_GRANT_ERROR, 403)
    }
  }
}
