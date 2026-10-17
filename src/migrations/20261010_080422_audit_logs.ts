import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`audit_logs_changes\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` text PRIMARY KEY NOT NULL,
  	\`path\` text NOT NULL,
  	\`old_value\` text,
  	\`new_value\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`audit_logs\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`audit_logs_changes_order_idx\` ON \`audit_logs_changes\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`audit_logs_changes_parent_id_idx\` ON \`audit_logs_changes\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`audit_logs\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`summary\` text NOT NULL,
  	\`action\` text NOT NULL,
  	\`collection_slug\` text NOT NULL,
  	\`document_id\` text NOT NULL,
  	\`actor_id\` integer,
  	\`operator_id\` text,
  	\`actor_email\` text,
  	\`ip_address\` text,
  	\`untrusted_client_ip\` text,
  	\`user_agent\` text,
  	\`occurred_at\` text NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`actor_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`audit_logs_action_idx\` ON \`audit_logs\` (\`action\`);`)
  await db.run(sql`CREATE INDEX \`audit_logs_collection_slug_idx\` ON \`audit_logs\` (\`collection_slug\`);`)
  await db.run(sql`CREATE INDEX \`audit_logs_document_id_idx\` ON \`audit_logs\` (\`document_id\`);`)
  await db.run(sql`CREATE INDEX \`audit_logs_actor_idx\` ON \`audit_logs\` (\`actor_id\`);`)
  await db.run(sql`CREATE INDEX \`audit_logs_operator_id_idx\` ON \`audit_logs\` (\`operator_id\`);`)
  await db.run(sql`CREATE INDEX \`audit_logs_actor_email_idx\` ON \`audit_logs\` (\`actor_email\`);`)
  await db.run(sql`CREATE INDEX \`audit_logs_occurred_at_idx\` ON \`audit_logs\` (\`occurred_at\`);`)
  await db.run(sql`CREATE INDEX \`audit_logs_updated_at_idx\` ON \`audit_logs\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`audit_logs_created_at_idx\` ON \`audit_logs\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`collectionSlug_documentId_idx\` ON \`audit_logs\` (\`collection_slug\`,\`document_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`audit_logs_changes\`;`)
  await db.run(sql`DROP TABLE \`audit_logs\`;`)
}
