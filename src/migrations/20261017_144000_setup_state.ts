import { type MigrateDownArgs, type MigrateUpArgs, sql } from '@payloadcms/db-d1-sqlite'

// First-run admin setup state (`setup-state`). The JSON snapshot next to this file is the
// full schema at this point; this migration only adds the new table and its trigger. Installs
// that already have users are recorded as set up, so the web setup screen stays closed for them.
// The trigger is not part of the Drizzle snapshot.
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
  // While a setup claim is live, `users` can hold at most one row. Same statement as
  // SETUP_GUARD_TRIGGER_SQL in src/auth/first-admin-setup.ts (a unit test keeps them equal).
  await db.run(sql.raw(SETUP_GUARD_TRIGGER_SQL))
}

export const SETUP_GUARD_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS setup_state_single_first_admin
BEFORE INSERT ON users
WHEN EXISTS (
  SELECT 1 FROM setup_state
  WHERE singleton = 'first-admin'
    AND claim_token IS NOT NULL
    AND claimed_at > (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 120000)
) AND EXISTS (SELECT 1 FROM users)
BEGIN
  SELECT RAISE(ABORT, 'first-run setup already created a user');
END`

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TRIGGER IF EXISTS \`setup_state_single_first_admin\``)
  await db.run(sql`DROP TABLE IF EXISTS \`setup_state\``)
}
