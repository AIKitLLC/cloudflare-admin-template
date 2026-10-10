import { sql, type ScopeSql } from './scope-sql'

/**
 * True when one of the actor's assignments on `path` covers `targetPath`.
 * An assignment whose own path already contains another assignment is ignored,
 * so a parent and its child do not both have to be tested.
 * The actor id is the only bound parameter.
 */
export function actorCoversPath(args: {
  actorId: number
  path: 'organizations' | 'branches' | 'dataClasses'
  fk: 'organizations_id' | 'branches_id' | 'data_classes_id'
  nodeTable: 'organizations' | 'branches' | 'data_classes'
  targetPath: string
}): ScopeSql {
  if (!/^[a-z0-9_.]+$/.test(args.targetPath)) {
    throw new Error(`Unexpected scope path ${args.targetPath}`)
  }
  const fk = sql.raw(args.fk)
  const nodeTable = sql.raw(args.nodeTable)
  const targetPath = sql.raw(args.targetPath)
  return sql`EXISTS (
    SELECT 1
    FROM users_rels actor
    INNER JOIN ${nodeTable} node ON node.id = actor.${fk}
    WHERE actor.parent_id = ${args.actorId}
      AND actor.path = ${args.path}
      AND ${targetPath} LIKE '%/' || node.id || '/%'
      AND NOT EXISTS (
        SELECT 1
        FROM users_rels ancestor
        INNER JOIN ${nodeTable} parent_node ON parent_node.id = ancestor.${fk}
        WHERE ancestor.parent_id = ${args.actorId}
          AND ancestor.path = ${args.path}
          AND ancestor.${fk} != actor.${fk}
          AND node.scope_path LIKE '%/' || parent_node.id || '/%'
      )
  )`
}
