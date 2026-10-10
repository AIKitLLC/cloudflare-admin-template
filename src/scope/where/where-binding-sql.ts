import type { PayloadRequest, Where } from 'payload'

import type { CollectionAction, RowScopeBinding } from '../../access/types'
import { SCOPE_PATH_FIELD } from '../constants'
import { columnForField, tableForCollection } from '../sql/collection-table'
import { actorCoversPath } from '../sql/actor-covers-path'
import { selectRows } from '../sql/select-rows'
import { sql, type ScopeSql } from '../sql/scope-sql'
import { matchNothing } from './match-nothing'
import { whereDocumentIds } from './where-id-in'

/**
 * Same scope rules as {@link whereForBinding}, expressed as one SELECT of ids.
 * The returned Where is a plain `id` list. The SQL stays on the server.
 */
export async function whereBindingIds(
  req: PayloadRequest,
  collectionSlug: string,
  binding: RowScopeBinding,
  action: CollectionAction,
  actorId: number,
): Promise<Where> {
  if (!Number.isInteger(actorId)) {
    return matchNothing()
  }
  const table = tableForCollection(req, collectionSlug)
  const condition = matchCondition(req, table, binding, action, actorId)
  if (!condition) {
    return matchNothing()
  }
  const rows = await selectRows(
    req,
    sql`SELECT ${quoted(table, 'id')} AS id FROM ${quotedTable(table)} WHERE ${condition}`,
  )
  return whereDocumentIds(idsFrom(rows))
}

function matchCondition(
  req: PayloadRequest,
  table: string,
  binding: RowScopeBinding,
  action: CollectionAction,
  actorId: number,
): ScopeSql | undefined {
  if (binding.dimension === 'organization') {
    return organizationNode(req, table, action, actorId)
  }
  if (binding.dimension === 'branch') {
    return branchNode(req, table, actorId)
  }
  if (binding.dimension === 'data-class') {
    return coversClass(actorId, pathOf(table, columnForField(req, table, SCOPE_PATH_FIELD)))
  }

  const parts: ScopeSql[] = []
  if (binding.organizationField) {
    parts.push(recordOrganization(req, table, binding.organizationField, actorId))
  }
  if (binding.branchField) {
    parts.push(recordBranch(req, table, binding.branchField, actorId))
  }
  if (binding.dataClassField) {
    parts.push(recordDataClass(req, table, binding.dataClassField, actorId))
  }
  if (parts.length === 0) {
    return undefined
  }
  return sql.join(parts, sql` AND `)
}

function organizationNode(
  req: PayloadRequest,
  table: string,
  action: CollectionAction,
  actorId: number,
): ScopeSql {
  const covered = coversOrg(actorId, pathOf(table, columnForField(req, table, SCOPE_PATH_FIELD)))
  if (action !== 'read' && action !== 'export') {
    return covered
  }
  return sql`${covered} OR EXISTS (
    SELECT 1
    FROM users_rels actor
    INNER JOIN branches assigned_branch ON assigned_branch.id = actor.branches_id
    WHERE actor.parent_id = ${actorId}
      AND actor.path = 'branches'
      AND assigned_branch.organization_id = ${quoted(table, 'id')}
  )`
}

function branchNode(req: PayloadRequest, table: string, actorId: number): ScopeSql {
  const scopeColumn = columnForField(req, table, SCOPE_PATH_FIELD)
  const organizationColumn = columnForField(req, table, 'organization')
  return sql`${coversBranch(actorId, pathOf(table, scopeColumn))} OR EXISTS (
    SELECT 1
    FROM organizations org
    WHERE org.id = ${quoted(table, organizationColumn)}
      AND ${coversOrg(actorId, 'org.scope_path')}
  )`
}

function recordOrganization(
  req: PayloadRequest,
  table: string,
  field: string,
  actorId: number,
): ScopeSql {
  return sql`EXISTS (
    SELECT 1
    FROM organizations org
    WHERE org.id = ${quoted(table, columnForField(req, table, field))}
      AND (
        ${coversOrg(actorId, 'org.scope_path')}
        OR EXISTS (
          SELECT 1
          FROM users_rels actor
          INNER JOIN branches assigned_branch ON assigned_branch.id = actor.branches_id
          WHERE actor.parent_id = ${actorId}
            AND actor.path = 'branches'
            AND assigned_branch.organization_id = org.id
        )
      )
  )`
}

function recordBranch(
  req: PayloadRequest,
  table: string,
  field: string,
  actorId: number,
): ScopeSql {
  return sql`EXISTS (
    SELECT 1
    FROM branches branch
    LEFT JOIN organizations branch_org ON branch_org.id = branch.organization_id
    WHERE branch.id = ${quoted(table, columnForField(req, table, field))}
      AND (
        ${coversBranch(actorId, 'branch.scope_path')}
        OR ${coversOrg(actorId, 'branch_org.scope_path')}
      )
  )`
}

function recordDataClass(
  req: PayloadRequest,
  table: string,
  field: string,
  actorId: number,
): ScopeSql {
  return sql`EXISTS (
    SELECT 1
    FROM data_classes data_class
    WHERE data_class.id = ${quoted(table, columnForField(req, table, field))}
      AND ${coversClass(actorId, 'data_class.scope_path')}
  )`
}

function pathOf(table: string, column: string): string {
  return `${table}.${column}`
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

function quotedTable(table: string): ScopeSql {
  return sql.raw(`"${table}"`)
}

function quoted(table: string, column: string): ScopeSql {
  return sql.raw(`"${table}"."${column}"`)
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
