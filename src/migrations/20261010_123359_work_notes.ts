import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`work_notes\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`title\` text NOT NULL,
  	\`owner_organization_id\` integer NOT NULL,
  	\`owner_branch_id\` integer NOT NULL,
  	\`owner_class_id\` integer NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`owner_organization_id\`) REFERENCES \`organizations\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`owner_branch_id\`) REFERENCES \`branches\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`owner_class_id\`) REFERENCES \`data_classes\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(
    sql`CREATE INDEX \`work_notes_owner_organization_idx\` ON \`work_notes\` (\`owner_organization_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`work_notes_owner_branch_idx\` ON \`work_notes\` (\`owner_branch_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX \`work_notes_owner_class_idx\` ON \`work_notes\` (\`owner_class_id\`);`,
  )
  await db.run(sql`CREATE INDEX \`work_notes_updated_at_idx\` ON \`work_notes\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`work_notes_created_at_idx\` ON \`work_notes\` (\`created_at\`);`)
  await db.run(
    sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`work_notes_id\` integer REFERENCES work_notes(id) ON UPDATE no action ON DELETE cascade;`,
  )
  await db.run(
    sql`CREATE INDEX \`payload_locked_documents_rels_work_notes_id_idx\` ON \`payload_locked_documents_rels\` (\`work_notes_id\`);`,
  )
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
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
  	\`organizations_id\` integer,
  	\`branches_id\` integer,
  	\`data_classes_id\` integer,
  	\`records_id\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_locked_documents\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`users_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`media_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`roles_id\`) REFERENCES \`roles\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`permissions_id\`) REFERENCES \`permissions\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`role_permissions_id\`) REFERENCES \`role_permissions\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`organizations_id\`) REFERENCES \`organizations\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`branches_id\`) REFERENCES \`branches\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`data_classes_id\`) REFERENCES \`data_classes\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`records_id\`) REFERENCES \`records\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(
    sql`INSERT INTO \`__new_payload_locked_documents_rels\`("id", "order", "parent_id", "path", "users_id", "media_id", "roles_id", "permissions_id", "role_permissions_id", "organizations_id", "branches_id", "data_classes_id", "records_id") SELECT "id", "order", "parent_id", "path", "users_id", "media_id", "roles_id", "permissions_id", "role_permissions_id", "organizations_id", "branches_id", "data_classes_id", "records_id" FROM \`payload_locked_documents_rels\` WHERE \`users_id\` IS NOT NULL OR \`media_id\` IS NOT NULL OR \`roles_id\` IS NOT NULL OR \`permissions_id\` IS NOT NULL OR \`role_permissions_id\` IS NOT NULL OR \`organizations_id\` IS NOT NULL OR \`branches_id\` IS NOT NULL OR \`data_classes_id\` IS NOT NULL OR \`records_id\` IS NOT NULL;`,
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
  await db.run(sql`DROP TABLE \`work_notes\`;`)
}
