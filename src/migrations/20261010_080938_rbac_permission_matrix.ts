import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`roles\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`slug\` text NOT NULL,
  	\`description\` text,
  	\`grants_full_access\` integer DEFAULT false,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`roles_slug_idx\` ON \`roles\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX \`roles_updated_at_idx\` ON \`roles\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`roles_created_at_idx\` ON \`roles\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`permissions\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`key\` text NOT NULL,
  	\`label\` text NOT NULL,
  	\`description\` text,
  	\`collection_slug\` text NOT NULL,
  	\`action\` text NOT NULL,
  	\`field_path\` text,
  	\`active\` integer DEFAULT true,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`permissions_key_idx\` ON \`permissions\` (\`key\`);`)
  await db.run(
    sql`CREATE INDEX \`permissions_collection_slug_idx\` ON \`permissions\` (\`collection_slug\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`permissions_updated_at_idx\` ON \`permissions\` (\`updated_at\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`permissions_created_at_idx\` ON \`permissions\` (\`created_at\`);`,
  )
  await db.run(sql`CREATE TABLE \`role_permissions\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`role_id\` integer NOT NULL,
  	\`permission_id\` integer NOT NULL,
  	\`granted\` integer DEFAULT true,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`role_id\`) REFERENCES \`roles\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`permission_id\`) REFERENCES \`permissions\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(
    sql`CREATE INDEX \`role_permissions_role_idx\` ON \`role_permissions\` (\`role_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`role_permissions_permission_idx\` ON \`role_permissions\` (\`permission_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`role_permissions_updated_at_idx\` ON \`role_permissions\` (\`updated_at\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`role_permissions_created_at_idx\` ON \`role_permissions\` (\`created_at\`);`,
  )
  await db.run(
    sql`CREATE UNIQUE INDEX \`role_permission_idx\` ON \`role_permissions\` (\`role_id\`,\`permission_id\`);`,
  )
  await db.run(sql`CREATE TABLE \`users_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` integer NOT NULL,
  	\`path\` text NOT NULL,
  	\`roles_id\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`roles_id\`) REFERENCES \`roles\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`users_rels_order_idx\` ON \`users_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`users_rels_parent_idx\` ON \`users_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`users_rels_path_idx\` ON \`users_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`users_rels_roles_id_idx\` ON \`users_rels\` (\`roles_id\`);`)
  await db.run(
    sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`roles_id\` integer REFERENCES roles(id);`,
  )
  await db.run(
    sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`permissions_id\` integer REFERENCES permissions(id);`,
  )
  await db.run(
    sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`role_permissions_id\` integer REFERENCES role_permissions(id);`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_roles_id_idx\` ON \`payload_locked_documents_rels\` (\`roles_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_permissions_id_idx\` ON \`payload_locked_documents_rels\` (\`permissions_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_role_permissions_id_idx\` ON \`payload_locked_documents_rels\` (\`role_permissions_id\`);`,
  )
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`users_rels\`;`)
  await db.run(sql`DROP TABLE \`role_permissions\`;`)
  await db.run(sql`DROP TABLE \`permissions\`;`)
  await db.run(sql`DROP TABLE \`roles\`;`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_payload_locked_documents_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` integer NOT NULL,
  	\`path\` text NOT NULL,
  	\`users_id\` integer,
  	\`media_id\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_locked_documents\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`users_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`media_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(
    sql`INSERT INTO \`__new_payload_locked_documents_rels\`("id", "order", "parent_id", "path", "users_id", "media_id") SELECT "id", "order", "parent_id", "path", "users_id", "media_id" FROM \`payload_locked_documents_rels\`;`,
  )
  await db.run(sql`DROP TABLE \`payload_locked_documents_rels\`;`)
  await db.run(
    sql`ALTER TABLE \`__new_payload_locked_documents_rels\` RENAME TO \`payload_locked_documents_rels\`;`,
  )
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_order_idx\` ON \`payload_locked_documents_rels\` (\`order\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_parent_idx\` ON \`payload_locked_documents_rels\` (\`parent_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_path_idx\` ON \`payload_locked_documents_rels\` (\`path\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_users_id_idx\` ON \`payload_locked_documents_rels\` (\`users_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_media_id_idx\` ON \`payload_locked_documents_rels\` (\`media_id\`);`,
  )
}
