import type { PayloadRequest, Where } from 'payload'

import { readVisibleUsersPromise, storeVisibleUsersPromise } from '../cache/scope-request-cache'
import { VISIBLE_USERS_CACHE_KEY } from '../constants'
import { actorCoversPath } from '../sql/actor-covers-path'
import { selectRows } from '../sql/select-rows'
import { sql, type ScopeSql } from '../sql/scope-sql'
import { matchNothing } from './match-nothing'
import { whereDocumentIds } from './where-id-in'

export async function whereUsersWithinScope(req: PayloadRequest): Promise<Where> {
  const userId = String(req.user?.id ?? '')
  const cached = readVisibleUsersPromise(req, userId)
  if (cached) {
    return cached
  }
  const pending = visibleUserWhere(req, userId)
  storeVisibleUsersPromise(req, userId, pending)
  try {
    return await pending
  } catch (error) {
    if (req.context) {
      delete req.context[VISIBLE_USERS_CACHE_KEY]
    }
    throw error
  }
}

/**
 * A limited reader sees an account when every assignment sits inside the caller's
 * scope, the account is not full access, and it has at least one assignment.
 * The caller always sees their own row. The ids come from one SELECT that joins
 * the caller's relationship rows, so the parameter count does not grow with the
 * number of assignments. The Where itself is a plain id list.
 */
async function visibleUserWhere(req: PayloadRequest, actorIdRaw: string): Promise<Where> {
  const actorId = Number(actorIdRaw)
  if (!Number.isInteger(actorId)) {
    return matchNothing()
  }
  const rows = await selectRows(
    req,
    sql`SELECT "users"."id" AS id FROM "users" WHERE ${selfOrScoped(actorId)}`,
  )
  return whereDocumentIds(idsFrom(rows))
}

function idsFrom(rows: Array<Record<string, unknown>>): Array<number | string> {
  const ids: Array<number | string> = []
  for (const row of rows) {
    if (typeof row.id === 'number' || typeof row.id === 'string') {
      ids.push(row.id)
    }
  }
  return ids
}

function selfOrScoped(actorId: number): ScopeSql {
  return sql`"users"."id" = ${actorId} OR (
    NOT EXISTS (
      SELECT 1
      FROM users_rels rel
      INNER JOIN roles role ON role.id = rel.roles_id
      WHERE rel.parent_id = "users"."id"
        AND rel.path = 'roles'
        AND role.grants_full_access = 1
    )
    AND EXISTS (
      SELECT 1
      FROM users_rels rel
      WHERE rel.parent_id = "users"."id"
        AND (
          rel.organizations_id IS NOT NULL
          OR rel.branches_id IS NOT NULL
          OR rel.data_classes_id IS NOT NULL
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM users_rels rel
      INNER JOIN organizations org ON org.id = rel.organizations_id
      WHERE rel.parent_id = "users"."id"
        AND rel.path = 'organizations'
        AND NOT (${coversOrg(actorId, 'org.scope_path')})
    )
    AND NOT EXISTS (
      SELECT 1
      FROM users_rels rel
      INNER JOIN branches branch ON branch.id = rel.branches_id
      LEFT JOIN organizations branch_org ON branch_org.id = branch.organization_id
      WHERE rel.parent_id = "users"."id"
        AND rel.path = 'branches'
        AND NOT (
          ${coversBranch(actorId, 'branch.scope_path')}
          OR ${coversOrg(actorId, 'branch_org.scope_path')}
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM users_rels rel
      INNER JOIN data_classes data_class ON data_class.id = rel.data_classes_id
      WHERE rel.parent_id = "users"."id"
        AND rel.path = 'dataClasses'
        AND NOT (${coversClass(actorId, 'data_class.scope_path')})
    )
  )`
}

function coversOrg(actorId: number, targetPath: string): ScopeSql {
  return actorCoversPath({
    actorId,
    path: 'organizations',
    fk: 'organizations_id',
    nodeTable: 'organizations',
    targetPath,
  })
}

function coversBranch(actorId: number, targetPath: string): ScopeSql {
  return actorCoversPath({
    actorId,
    path: 'branches',
    fk: 'branches_id',
    nodeTable: 'branches',
    targetPath,
  })
}

function coversClass(actorId: number, targetPath: string): ScopeSql {
  return actorCoversPath({
    actorId,
    path: 'dataClasses',
    fk: 'data_classes_id',
    nodeTable: 'data_classes',
    targetPath,
  })
}
