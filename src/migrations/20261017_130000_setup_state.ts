import { type MigrateDownArgs, type MigrateUpArgs, sql } from '@payloadcms/db-d1-sqlite'

// First-run admin setup state (`setup-state`). The JSON snapshot next to this file is the
// full schema at this point; this migration only adds the new table. Installs that already
// have users are recorded as set up, so the web setup screen stays closed for them.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(
    sql`CREATE TABLE IF NOT EXISTS \`setup_state\` (\`id\` integer PRIMARY KEY NOT NULL, \`singleton\` text NOT NULL, \`claim_token\` text, \`claimed_at\` numeric, \`completed_at\` numeric)`,
  )
  await db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS \`setup_state_singleton_idx\` ON \`setup_state\` (\`singleton\`)`,
  )
  await db.run(
    sql`INSERT INTO \`setup_state\` (\`singleton\`, \`completed_at\`) SELECT 'first-admin', ${Date.now()} WHERE EXISTS (SELECT 1 FROM \`users\`) ON CONFLICT(\`singleton\`) DO NOTHING`,
  )
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE IF EXISTS \`setup_state\``)
}
