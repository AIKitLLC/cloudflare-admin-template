import { type MigrateDownArgs, type MigrateUpArgs, sql } from '@payloadcms/db-d1-sqlite'

// Per-IP sign-in counters (`login-throttle`). The JSON snapshot next to this file is the
// full schema at this point; this migration only adds the new table.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(
    sql`CREATE TABLE IF NOT EXISTS \`login_throttle\` (\`id\` integer PRIMARY KEY NOT NULL, \`bucket_key\` text NOT NULL, \`used\` numeric NOT NULL, \`reset_at\` numeric NOT NULL)`,
  )
  await db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS \`login_throttle_bucket_key_idx\` ON \`login_throttle\` (\`bucket_key\`)`,
  )
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE IF EXISTS \`login_throttle\``)
}
