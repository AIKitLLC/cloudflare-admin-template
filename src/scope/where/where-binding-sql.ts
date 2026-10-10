import type { Where } from 'payload'

import type { CollectionAction, RowScopeBinding } from '../../access/types'
import { actorCoversPath } from '../sql/actor-covers-path'
import { sql, type ScopeSql } from '../sql/scope-sql'
import { whereRowMatches } from '../sql/where-sql'
import { matchNothing } from './match-nothing'

/** Same scope rules as {@link whereForBinding}, joined to the actor's assignments. */
export function whereBindingSql(
  binding: RowScopeBinding,
  action: CollectionAction,
  actorId: number,
): Where {
  if (!Number.isInteger(actorId)) {
    return matchNothing()
  }
  if (binding.dimension === 'organization') {
    return whereRowMatches('organizations', organizationNode(action, actorId))
  }
  if (binding.dimension === 'branch') {
    return whereRowMatches('branches', branchNode(actorId))
  }
  if (binding.dimension === 'data-class') {
    return whereRowMatches('data_classes', coversClass(actorId, '"data_classes"."scope_path"'))
  }

  const parts: ScopeSql[] = []
  if (binding.organizationField) {
    parts.push(recordOrganization(actorId))
  }
  if (binding.branchField) {
    parts.push(recordBranch(actorId))
  }
  if (binding.dataClassField) {
    parts.push(recordDataClass(actorId))
  }
  if (parts.length === 0) {
    return matchNothing()
  }
  return whereRowMatches('records', sql.join(parts, sql` AND `))
}

function organizationNode(action: CollectionAction, actorId: number): ScopeSql {
  const covered = coversOrg(actorId, '"organizations"."scope_path"')
  if (action !== 'read' && action !== 'export') {
    return covered
  }
  return sql`${covered} OR EXISTS (
    SELECT 1
    FROM users_rels actor
    INNER JOIN branches assigned_branch ON assigned_branch.id = actor.branches_id
    WHERE actor.parent_id = ${actorId}
      AND actor.path = 'branches'
      AND assigned_branch.organization_id = "organizations"."id"
  )`
}

function branchNode(actorId: number): ScopeSql {
  return sql`${coversBranch(actorId, '"branches"."scope_path"')} OR EXISTS (
    SELECT 1
    FROM organizations org
    WHERE org.id = "branches"."organization_id"
      AND ${coversOrg(actorId, 'org.scope_path')}
  )`
}

function recordOrganization(actorId: number): ScopeSql {
  return sql`EXISTS (
    SELECT 1
    FROM organizations org
    WHERE org.id = "records"."organization_id"
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

function recordBranch(actorId: number): ScopeSql {
  return sql`EXISTS (
    SELECT 1
    FROM branches branch
    LEFT JOIN organizations branch_org ON branch_org.id = branch.organization_id
    WHERE branch.id = "records"."branch_id"
      AND (
        ${coversBranch(actorId, 'branch.scope_path')}
        OR ${coversOrg(actorId, 'branch_org.scope_path')}
      )
  )`
}

function recordDataClass(actorId: number): ScopeSql {
  return sql`EXISTS (
    SELECT 1
    FROM data_classes data_class
    WHERE data_class.id = "records"."data_class_id"
      AND ${coversClass(actorId, 'data_class.scope_path')}
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
