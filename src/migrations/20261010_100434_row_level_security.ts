import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`organizations\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`slug\` text NOT NULL,
  	\`parent_id\` integer,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`organizations\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`organizations_slug_idx\` ON \`organizations\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX \`organizations_parent_idx\` ON \`organizations\` (\`parent_id\`);`)
  await db.run(
    sql`CREATE INDEX \`organizations_updated_at_idx\` ON \`organizations\` (\`updated_at\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`organizations_created_at_idx\` ON \`organizations\` (\`created_at\`);`,
  )
  await db.run(sql`CREATE TABLE \`branches\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`slug\` text NOT NULL,
  	\`organization_id\` integer NOT NULL,
  	\`parent_id\` integer,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`organization_id\`) REFERENCES \`organizations\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`branches\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`branches_slug_idx\` ON \`branches\` (\`slug\`);`)
  await db.run(
    sql`CREATE INDEX \`branches_organization_idx\` ON \`branches\` (\`organization_id\`);`,
  )
  await db.run(sql`CREATE INDEX \`branches_parent_idx\` ON \`branches\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`branches_updated_at_idx\` ON \`branches\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`branches_created_at_idx\` ON \`branches\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`data_classes\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`slug\` text NOT NULL,
  	\`parent_id\` integer,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`data_classes\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`data_classes_slug_idx\` ON \`data_classes\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX \`data_classes_parent_idx\` ON \`data_classes\` (\`parent_id\`);`)
  await db.run(
    sql`CREATE INDEX \`data_classes_updated_at_idx\` ON \`data_classes\` (\`updated_at\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`data_classes_created_at_idx\` ON \`data_classes\` (\`created_at\`);`,
  )
  await db.run(sql`CREATE TABLE \`records\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`title\` text NOT NULL,
  	\`organization_id\` integer NOT NULL,
  	\`branch_id\` integer NOT NULL,
  	\`data_class_id\` integer NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`organization_id\`) REFERENCES \`organizations\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`branch_id\`) REFERENCES \`branches\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`data_class_id\`) REFERENCES \`data_classes\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`records_organization_idx\` ON \`records\` (\`organization_id\`);`)
  await db.run(sql`CREATE INDEX \`records_branch_idx\` ON \`records\` (\`branch_id\`);`)
  await db.run(sql`CREATE INDEX \`records_data_class_idx\` ON \`records\` (\`data_class_id\`);`)
  await db.run(sql`CREATE INDEX \`records_updated_at_idx\` ON \`records\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`records_created_at_idx\` ON \`records\` (\`created_at\`);`)
  await db.run(
    sql`ALTER TABLE \`users_rels\` ADD \`organizations_id\` integer REFERENCES organizations(id);`,
  )
  await db.run(sql`ALTER TABLE \`users_rels\` ADD \`branches_id\` integer REFERENCES branches(id);`)
  await db.run(
    sql`ALTER TABLE \`users_rels\` ADD \`data_classes_id\` integer REFERENCES data_classes(id);`,
  )
  await db.run(
    sql`CREATE INDEX \`users_rels_organizations_id_idx\` ON \`users_rels\` (\`organizations_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`users_rels_branches_id_idx\` ON \`users_rels\` (\`branches_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`users_rels_data_classes_id_idx\` ON \`users_rels\` (\`data_classes_id\`);`,
  )
  await db.run(
    sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`organizations_id\` integer REFERENCES organizations(id);`,
  )
  await db.run(
    sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`branches_id\` integer REFERENCES branches(id);`,
  )
  await db.run(
    sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`data_classes_id\` integer REFERENCES data_classes(id);`,
  )
  await db.run(
    sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`records_id\` integer REFERENCES records(id);`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_organizations_id_idx\` ON \`payload_locked_documents_rels\` (\`organizations_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_branches_id_idx\` ON \`payload_locked_documents_rels\` (\`branches_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_data_classes_id_idx\` ON \`payload_locked_documents_rels\` (\`data_classes_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_records_id_idx\` ON \`payload_locked_documents_rels\` (\`records_id\`);`,
  )
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`DROP TABLE \`records\`;`)
  await db.run(sql`DROP TABLE \`branches\`;`)
  await db.run(sql`DROP TABLE \`data_classes\`;`)
  await db.run(sql`DROP TABLE \`organizations\`;`)
  await db.run(sql`CREATE TABLE \`__new_users_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` integer NOT NULL,
  	\`path\` text NOT NULL,
  	\`roles_id\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`roles_id\`) REFERENCES \`roles\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(
    sql`INSERT INTO \`__new_users_rels\`("id", "order", "parent_id", "path", "roles_id") SELECT "id", "order", "parent_id", "path", "roles_id" FROM \`users_rels\`;`,
  )
  await db.run(sql`DROP TABLE \`users_rels\`;`)
  await db.run(sql`ALTER TABLE \`__new_users_rels\` RENAME TO \`users_rels\`;`)
  await db.run(sql`CREATE INDEX \`users_rels_order_idx\` ON \`users_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`users_rels_parent_idx\` ON \`users_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`users_rels_path_idx\` ON \`users_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`users_rels_roles_id_idx\` ON \`users_rels\` (\`roles_id\`);`)
  await db.run(sql`CREATE TABLE \`__new_payload_locked_documents_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` integer NOT NULL,
  	\`path\` text NOT NULL,
  	\`users_id\` integer,
  	\`media_id\` integer,
  	\`roles_id\` integer,
  	\`permissions_id\` integer,
  	\`role_permissions_id\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_locked_documents\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`users_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`media_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`roles_id\`) REFERENCES \`roles\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`permissions_id\`) REFERENCES \`permissions\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`role_permissions_id\`) REFERENCES \`role_permissions\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(
    sql`INSERT INTO \`__new_payload_locked_documents_rels\`("id", "order", "parent_id", "path", "users_id", "media_id", "roles_id", "permissions_id", "role_permissions_id") SELECT "id", "order", "parent_id", "path", "users_id", "media_id", "roles_id", "permissions_id", "role_permissions_id" FROM \`payload_locked_documents_rels\`;`,
  )
  await db.run(sql`DROP TABLE \`payload_locked_documents_rels\`;`)
  await db.run(
    sql`ALTER TABLE \`__new_payload_locked_documents_rels\` RENAME TO \`payload_locked_documents_rels\`;`,
  )
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
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_roles_id_idx\` ON \`payload_locked_documents_rels\` (\`roles_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_permissions_id_idx\` ON \`payload_locked_documents_rels\` (\`permissions_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_role_permissions_id_idx\` ON \`payload_locked_documents_rels\` (\`role_permissions_id\`);`,
  )
  await db.run(sql`PRAGMA foreign_keys=ON;`)
}
