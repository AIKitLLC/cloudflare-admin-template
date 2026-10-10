import type { PayloadRequest } from 'payload'
import { APIError } from 'payload'

import { loadUserGrants } from '../../access/resolve/load-user-grants'
import { fullAccessRoleIds } from '../../rbac/guards/full-access-role-ids'
import { grantedKeysByRole } from '../../rbac/guards/role-permission-keys'
import { addedRoleIds, roleIdList } from '../../rbac/guards/role-id-set'
import {
  USER_BRANCHES_FIELD,
  USER_DATA_CLASSES_FIELD,
  USER_ORGANIZATIONS_FIELD,
  USER_SCOPE_FIELDS,
  type UserScopeField,
} from '../constants'
import {
  SCOPE_ROLE_TARGET_ERROR,
  SCOPE_TARGET_KEYS_ERROR,
  SELF_SCOPE_ASSIGNMENT_ERROR,
} from '../errors'
import { idSet, sameIdSet, toPayloadIds } from '../ids/id-set'
import { loadEffectiveScope } from '../resolve/load-effective-scope'
import { loadScopeCatalog } from '../resolve/load-scope-catalog'
import { resolveEffectiveScope } from '../resolve/resolve-effective-scope'
import type { EffectiveScope, ScopeAssignments } from '../types'
import { isScopeWithin } from './is-scope-within'
import { mergeScopeField } from './merge-scope-field'

const GRANTABLE_FIELD: Record<UserScopeField, (scope: EffectiveScope) => ReadonlySet<string>> = {
  [USER_ORGANIZATIONS_FIELD]: (scope) => scope.grantableOrganizationIds,
  [USER_BRANCHES_FIELD]: (scope) => scope.branchIds,
  [USER_DATA_CLASSES_FIELD]: (scope) => scope.dataClassIds,
}

export async function applyScopeAssignmentPolicy(args: {
  data: Record<string, unknown>
  original?: Record<string, unknown> | null
  req: PayloadRequest
  targetId?: number | string | null
}): Promise<Record<string, unknown>> {
  const scopeTouched = USER_SCOPE_FIELDS.some((field) => args.data[field] !== undefined)
  const rolesTouched = args.data.roles !== undefined
  if (!scopeTouched && !rolesTouched) {
    return args.data
  }

  const actorId = String(args.req.user?.id ?? '')
  const targetId =
    args.targetId === undefined || args.targetId === null ? undefined : String(args.targetId)
  const actorScope = await loadEffectiveScope(args.req)
  const next: Record<string, unknown> = { ...args.data }

  if (
    scopeTouched &&
    targetId &&
    targetId === actorId &&
    scopeFieldsChanged(args.data, args.original)
  ) {
    throw new APIError(SELF_SCOPE_ASSIGNMENT_ERROR, 403)
  }

  let scopeExtended = false
  if (scopeTouched && targetId !== actorId) {
    for (const field of USER_SCOPE_FIELDS) {
      if (args.data[field] === undefined) {
        continue
      }
      const previous = idSet(args.original?.[field])
      const submitted = idSet(args.data[field])
      const merged = mergeScopeField(previous, submitted, GRANTABLE_FIELD[field](actorScope))
      if (setGrew(previous, merged)) {
        scopeExtended = true
      }
      next[field] = toPayloadIds(merged)
    }
  }

  if (scopeExtended) {
    const roleSource = next.roles !== undefined ? next.roles : args.original?.roles
    await assertTargetKeysAllowScopeExtension(args.req, roleIdList(roleSource))
  }

  if (rolesTouched) {
    const previousRoles = roleIdList(args.original?.roles)
    const submittedRoles = roleIdList(args.data.roles)
    if (addedRoleIds(previousRoles, submittedRoles).length > 0) {
      const catalog = await loadScopeCatalog(args.req)
      const targetScope = resolveEffectiveScope(catalog, storedAssignments(next, args.original))
      if (!isScopeWithin(targetScope, actorScope)) {
        throw new APIError(SCOPE_ROLE_TARGET_ERROR, 403)
      }
    }
  }

  return next
}

function setGrew(previous: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  for (const id of next) {
    if (!previous.has(id)) {
      return true
    }
  }
  return false
}

async function assertTargetKeysAllowScopeExtension(
  req: PayloadRequest,
  roleIds: string[],
): Promise<void> {
  const privilegedRoles = await fullAccessRoleIds(req)
  if (roleIds.some((roleId) => privilegedRoles.has(roleId))) {
    throw new APIError(SCOPE_TARGET_KEYS_ERROR, 403)
  }
  const [grants, keysByRole] = await Promise.all([
    loadUserGrants(req),
    grantedKeysByRole(req, roleIds),
  ])
  for (const keys of keysByRole.values()) {
    for (const key of keys) {
      if (!grants?.permissionKeys.has(key)) {
        throw new APIError(SCOPE_TARGET_KEYS_ERROR, 403)
      }
    }
  }
}

function scopeFieldsChanged(
  data: Record<string, unknown>,
  original: Record<string, unknown> | null | undefined,
): boolean {
  for (const field of USER_SCOPE_FIELDS) {
    if (data[field] === undefined) {
      continue
    }
    if (!sameIdSet(idSet(data[field]), idSet(original?.[field]))) {
      return true
    }
  }
  return false
}

function storedAssignments(
  data: Record<string, unknown>,
  original: Record<string, unknown> | null | undefined,
): ScopeAssignments {
  return {
    organizationIds: storedIds(data, original, USER_ORGANIZATIONS_FIELD),
    branchIds: storedIds(data, original, USER_BRANCHES_FIELD),
    dataClassIds: storedIds(data, original, USER_DATA_CLASSES_FIELD),
  }
}

function storedIds(
  data: Record<string, unknown>,
  original: Record<string, unknown> | null | undefined,
  field: UserScopeField,
): string[] {
  const value = data[field] === undefined ? original?.[field] : data[field]
  return [...idSet(value)]
}
