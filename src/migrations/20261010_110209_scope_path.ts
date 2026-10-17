import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`organizations\` ADD \`scope_path\` text;`)
  await db.run(
    sql`CREATE INDEX \`organizations_scope_path_idx\` ON \`organizations\` (\`scope_path\`);`,
  )
  await db.run(sql`ALTER TABLE \`branches\` ADD \`scope_path\` text;`)
  await db.run(sql`CREATE INDEX \`branches_scope_path_idx\` ON \`branches\` (\`scope_path\`);`)
  await db.run(sql`ALTER TABLE \`data_classes\` ADD \`scope_path\` text;`)
  await db.run(
    sql`CREATE INDEX \`data_classes_scope_path_idx\` ON \`data_classes\` (\`scope_path\`);`,
  )
  await backfillPath(db, 'organizations')
  await backfillPath(db, 'branches')
  await backfillPath(db, 'data_classes')
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`organizations_scope_path_idx\`;`)
  await db.run(sql`ALTER TABLE \`organizations\` DROP COLUMN \`scope_path\`;`)
  await db.run(sql`DROP INDEX \`branches_scope_path_idx\`;`)
  await db.run(sql`ALTER TABLE \`branches\` DROP COLUMN \`scope_path\`;`)
  await db.run(sql`DROP INDEX \`data_classes_scope_path_idx\`;`)
  await db.run(sql`ALTER TABLE \`data_classes\` DROP COLUMN \`scope_path\`;`)
}

async function backfillPath(
  db: MigrateUpArgs['db'],
  table: 'organizations' | 'branches' | 'data_classes',
): Promise<void> {
  await db.run(
    sql.raw(`WITH RECURSIVE scope_paths AS (
    SELECT id, '/' || id || '/' AS scope_path
    FROM ${table}
    WHERE parent_id IS NULL
    UNION ALL
    SELECT child.id, parent.scope_path || child.id || '/'
    FROM ${table} AS child
    JOIN scope_paths AS parent ON child.parent_id = parent.id
  )
  UPDATE ${table}
  SET scope_path = (
    SELECT scope_paths.scope_path FROM scope_paths WHERE scope_paths.id = ${table}.id
  )
  WHERE scope_path IS NULL;`),
  )
}
