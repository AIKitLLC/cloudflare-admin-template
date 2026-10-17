import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`jobs\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`payload\` text DEFAULT '{}' NOT NULL,
  	\`status\` text DEFAULT 'PENDING' NOT NULL,
  	\`error\` text,
  	\`logs\` text DEFAULT '[]',
  	\`attempt\` numeric DEFAULT 0 NOT NULL,
  	\`max_attempts\` numeric DEFAULT 5 NOT NULL,
  	\`run_at\` text,
  	\`lease_expires_at\` text,
  	\`started_at\` text,
  	\`finished_at\` text,
  	\`idempotency_key\` text NOT NULL,
  	\`claim_token\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`jobs_name_idx\` ON \`jobs\` (\`name\`);`)
  await db.run(sql`CREATE INDEX \`jobs_status_idx\` ON \`jobs\` (\`status\`);`)
  await db.run(sql`CREATE INDEX \`jobs_run_at_idx\` ON \`jobs\` (\`run_at\`);`)
  await db.run(sql`CREATE INDEX \`jobs_lease_expires_at_idx\` ON \`jobs\` (\`lease_expires_at\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`jobs_idempotency_key_idx\` ON \`jobs\` (\`idempotency_key\`);`)
  await db.run(sql`CREATE INDEX \`jobs_updated_at_idx\` ON \`jobs\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`jobs_created_at_idx\` ON \`jobs\` (\`created_at\`);`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`jobs\`;`)
}
