import {
  canonicalClientSecurityConfiguration,
  DEFAULT_CLIENT_SECURITY_CONFIGURATION,
  digestClientSecurityConfiguration,
} from './schema'

export const CLIENT_SECURITY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS client_security_state (id integer PRIMARY KEY NOT NULL, revision numeric NOT NULL, commit_nonce text, admission_nonce text, admission_allowed numeric)`,
  `CREATE TABLE IF NOT EXISTS client_security_versions (id integer PRIMARY KEY NOT NULL, revision numeric NOT NULL, configuration text NOT NULL, digest text NOT NULL, actor text NOT NULL, operation text NOT NULL, created_at text NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS client_security_versions_revision_idx ON client_security_versions (revision)`,
  `CREATE TABLE IF NOT EXISTS client_security_counters (id integer PRIMARY KEY NOT NULL, bucket_key text NOT NULL, used numeric NOT NULL, reset_at numeric NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS client_security_counters_bucket_key_idx ON client_security_counters (bucket_key)`,
  `CREATE TABLE IF NOT EXISTS client_security_audit (id integer PRIMARY KEY NOT NULL, revision numeric NOT NULL, previous_revision numeric NOT NULL, actor text NOT NULL, operation text NOT NULL, created_at text NOT NULL)`,
  // Payload 3.82's generated schema includes its internal key/value table.
  `CREATE TABLE IF NOT EXISTS payload_kv (id integer PRIMARY KEY NOT NULL, key text NOT NULL, data text NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS payload_kv_key_idx ON payload_kv (key)`,
] as const

export const CLIENT_SECURITY_RELATIONS = [
  ['client_security_state', 'payload_locked_documents_rels_client_security_state_id_idx'],
  ['client_security_versions', 'payload_locked_documents_rels_client_security_versions_i_idx'],
  ['client_security_counters', 'payload_locked_documents_rels_client_security_counters_i_idx'],
  ['client_security_audit', 'payload_locked_documents_rels_client_security_audit_id_idx'],
] as const

export const CLIENT_SECURITY_OWNER_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS client_security_last_owner_delete BEFORE DELETE ON users WHEN OLD.role = 'owner' AND (SELECT count(*) FROM users WHERE role = 'owner') <= 1 BEGIN SELECT RAISE(ABORT, 'last_owner_required'); END`,
  `CREATE TRIGGER IF NOT EXISTS client_security_last_owner_update BEFORE UPDATE OF role ON users WHEN OLD.role = 'owner' AND (NEW.role IS NULL OR NEW.role <> 'owner') AND (SELECT count(*) FROM users WHERE role = 'owner') <= 1 BEGIN SELECT RAISE(ABORT, 'last_owner_required'); END`,
] as const

/** Migration/test initialization only. Request handlers never create or repair security state. */
export async function initializeClientSecuritySchema(db: D1Database): Promise<void> {
  const columns = await db.prepare('PRAGMA table_info(users)').all<{ name: string }>()
  if (!columns.results.some(({ name }) => name === 'role')) {
    await db.prepare("ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'admin'").run()
  }
  const configuration = canonicalClientSecurityConfiguration(DEFAULT_CLIENT_SECURITY_CONFIGURATION)
  const digest = await digestClientSecurityConfiguration(DEFAULT_CLIENT_SECURITY_CONFIGURATION)
  await db.batch([
    ...CLIENT_SECURITY_SCHEMA.map((statement) => db.prepare(statement)),
    ...CLIENT_SECURITY_OWNER_TRIGGERS.map((statement) => db.prepare(statement)),
    db
      .prepare(
        `INSERT OR IGNORE INTO client_security_versions (revision, configuration, digest, actor, operation, created_at) SELECT 0, ?, ?, 'system', 'initialize', strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM client_security_state WHERE id = 1)`,
      )
      .bind(configuration, digest),
    db.prepare(
      `INSERT INTO client_security_audit (revision, previous_revision, actor, operation, created_at) SELECT 0, 0, 'system', 'initialize', strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM client_security_state WHERE id = 1)`,
    ),
    db.prepare('INSERT OR IGNORE INTO client_security_state (id, revision) VALUES (1, 0)'),
  ])
  const relations = await db
    .prepare('PRAGMA table_info(payload_locked_documents_rels)')
    .all<{ name: string }>()
  if (relations.results.length) {
    for (const [table, index] of CLIENT_SECURITY_RELATIONS) {
      if (!relations.results.some(({ name }) => name === `${table}_id`)) {
        await db
          .prepare(
            `ALTER TABLE payload_locked_documents_rels ADD ${table}_id integer REFERENCES ${table}(id)`,
          )
          .run()
      }
      await db
        .prepare(
          `CREATE INDEX IF NOT EXISTS ${index} ON payload_locked_documents_rels (${table}_id)`,
        )
        .run()
    }
  }
}
