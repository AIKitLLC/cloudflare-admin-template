import { type MigrateUpArgs, type MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

import {
  CLIENT_SECURITY_SCHEMA,
  CLIENT_SECURITY_OWNER_TRIGGERS,
  CLIENT_SECURITY_RELATIONS,
} from '../client-security/initialize'
import {
  canonicalClientSecurityConfiguration,
  DEFAULT_CLIENT_SECURITY_CONFIGURATION,
  digestClientSecurityConfiguration,
} from '../client-security/schema'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  const columns = await db.all<{ name: string }>(sql`PRAGMA table_info(users)`)
  if (!columns.some(({ name }) => name === 'role')) {
    await db.run(sql`ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'admin'`)
  }
  for (const statement of [...CLIENT_SECURITY_SCHEMA, ...CLIENT_SECURITY_OWNER_TRIGGERS]) {
    await db.run(sql.raw(statement))
  }
  const relations = await db.all<{ name: string }>(
    sql`PRAGMA table_info(payload_locked_documents_rels)`,
  )
  for (const [table, index] of CLIENT_SECURITY_RELATIONS) {
    if (!relations.some(({ name }) => name === `${table}_id`)) {
      await db.run(
        sql.raw(
          `ALTER TABLE payload_locked_documents_rels ADD ${table}_id integer REFERENCES ${table}(id)`,
        ),
      )
    }
    await db.run(
      sql.raw(`CREATE INDEX IF NOT EXISTS ${index} ON payload_locked_documents_rels (${table}_id)`),
    )
  }
  const configuration = canonicalClientSecurityConfiguration(DEFAULT_CLIENT_SECURITY_CONFIGURATION)
  const digest = await digestClientSecurityConfiguration(DEFAULT_CLIENT_SECURITY_CONFIGURATION)
  await db.run(
    sql`INSERT OR IGNORE INTO client_security_versions (revision, configuration, digest, actor, operation, created_at) SELECT 0, ${configuration}, ${digest}, 'system', 'initialize', strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM client_security_state WHERE id = 1)`,
  )
  await db.run(
    sql`INSERT INTO client_security_audit (revision, previous_revision, actor, operation, created_at) SELECT 0, 0, 'system', 'initialize', strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM client_security_state WHERE id = 1)`,
  )
  await db.run(sql`INSERT OR IGNORE INTO client_security_state (id, revision) VALUES (1, 0)`)
}

/** Config rollback is a reviewed new revision. Downgrading schema must retain audit/counters. */
export async function down(_args: MigrateDownArgs): Promise<void> {
  throw new Error(
    'Client security migration requires an operator-reviewed data-preserving downgrade',
  )
}
