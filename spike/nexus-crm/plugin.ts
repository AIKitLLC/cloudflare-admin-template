// THROWAWAY spike for #44. Hybrid model: standard objects are real collections (variant a),
// custom objects created at runtime live in `nexus_records` (variant b) and are described by
// rows in `nexus_object_definitions`. Variant c is wired only so it can be measured.
import type { CollectionConfig, CollectionSlug, Config, Payload } from 'payload'

import { withRbac } from '../../src/access'
import { withAuditTrail } from '../../src/audit'
import {
  NEXUS_PREFIX,
  standardDefinitions,
  standardSlug,
  type ObjectDefinition,
} from './definitions'
import { collectionFromDefinition } from './variant-a-codegen'
import { adapterEndpoints, registerAdapterPermissions } from './variant-c-adapter'
import { NEXUS_RECORDS_SLUG, universalRecords, type DefinitionResolver } from './variant-b-universal'

export const OBJECT_DEFINITIONS_SLUG = 'nexus_object_definitions'

// Custom objects are data, so a new object or field needs no migration and no deploy.
export const ObjectDefinitions: CollectionConfig = withAuditTrail(
  withRbac({
    slug: OBJECT_DEFINITIONS_SLUG,
    labels: { singular: 'Object Definition', plural: 'Object Definitions' },
    admin: { group: 'Nexus CRM', useAsTitle: 'singular' },
    fields: [
      { name: 'key', type: 'text', required: true, unique: true, index: true },
      { name: 'singular', type: 'text', required: true },
      { name: 'plural', type: 'text', required: true },
      { name: 'titleField', type: 'text', required: true },
      { name: 'fields', type: 'json', required: true },
    ],
  }),
)

export const resolveDefinitions: DefinitionResolver = async (req) => {
  const custom = await req.payload.find({
    collection: OBJECT_DEFINITIONS_SLUG as CollectionSlug,
    depth: 0,
    limit: 100,
    overrideAccess: true,
  })
  return [...standardDefinitions, ...(custom.docs as unknown as ObjectDefinition[])]
}

type RoleSeed = { slug: string; name: string; actions: string[]; definitionsAccess: 'none' | 'read' | 'all' }

// Nexus memberships.role -> RBAC role. `owner` is a normal role (decision A1), never `grantsFullAccess`.
export const NEXUS_ROLES: RoleSeed[] = [
  { slug: 'nexus-owner', name: 'Nexus Owner', actions: ['create', 'read', 'update', 'delete', 'export', 'readField', 'writeField'], definitionsAccess: 'all' },
  { slug: 'nexus-admin', name: 'Nexus Admin', actions: ['create', 'read', 'update', 'delete', 'export', 'readField', 'writeField'], definitionsAccess: 'all' },
  { slug: 'nexus-manager', name: 'Nexus Manager', actions: ['create', 'read', 'update', 'delete', 'export', 'readField', 'writeField'], definitionsAccess: 'read' },
  { slug: 'nexus-member', name: 'Nexus Member', actions: ['create', 'read', 'update', 'readField', 'writeField'], definitionsAccess: 'read' },
  { slug: 'nexus-viewer', name: 'Nexus Viewer', actions: ['read', 'readField'], definitionsAccess: 'none' },
]

export async function seedNexusRoles(payload: Payload): Promise<void> {
  const permissions = await payload.find({
    collection: 'permissions' as CollectionSlug,
    depth: 0,
    limit: 500,
    pagination: false,
    overrideAccess: true,
    where: { collectionSlug: { like: NEXUS_PREFIX }, active: { equals: true } },
  })
  const nexus = permissions.docs as unknown as { id: number; key: string; collectionSlug: string; action: string }[]
  for (const seed of NEXUS_ROLES) {
    const existing = await payload.find({
      collection: 'roles' as CollectionSlug,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { slug: { equals: seed.slug } },
    })
    const role =
      existing.docs[0] ??
      (await payload.create({
        collection: 'roles' as CollectionSlug,
        data: { slug: seed.slug, name: seed.name, grantsFullAccess: false },
        overrideAccess: true,
      }))
    for (const permission of nexus) {
      const isDefinitions = permission.collectionSlug === OBJECT_DEFINITIONS_SLUG
      const allowed = isDefinitions
        ? seed.definitionsAccess === 'all' || (seed.definitionsAccess === 'read' && ['read', 'readField'].includes(permission.action))
        : seed.actions.includes(permission.action)
      if (!allowed) continue
      const already = await payload.find({
        collection: 'role-permissions' as CollectionSlug,
        depth: 0,
        limit: 1,
        overrideAccess: true,
        where: { and: [{ role: { equals: role.id } }, { permission: { equals: permission.id } }] },
      })
      if (already.docs.length === 0) {
        await payload.create({
          collection: 'role-permissions' as CollectionSlug,
          data: { role: role.id, permission: permission.id, granted: true },
          overrideAccess: true,
        })
      }
    }
  }
}

export const NEXUS_SPIKE_MIGRATIONS = [
  { name: 'nexus_20261026_spike_noop', up: async () => {}, down: async () => {} },
]

// Appends plugin migrations to the D1 adapter's `prodMigrations`. The adapter is built inside `config.db.init`,
// so this wraps `init`. Production Payload applies `prodMigrations` on connect; `payload migrate` reads files only.
export function withPluginMigrations(config: Config, migrations: unknown[]): Config {
  const db = config.db as { init: (args: { payload: Payload }) => { prodMigrations?: unknown[] } } | undefined
  if (!db) return config
  const init = db.init
  return {
    ...config,
    db: {
      ...db,
      init: (args) => {
        const adapter = init(args)
        adapter.prodMigrations = [...(adapter.prodMigrations ?? []), ...migrations]
        return adapter
      },
    } as Config['db'],
  }
}

export function createNexusSpikePlugin() {
  registerAdapterPermissions()
  return (config: Config): Config => {
    const previousOnInit = config.onInit
    const withPlugin: Config = {
      ...config,
      collections: [
        ...(config.collections ?? []),
        ...standardDefinitions.map(collectionFromDefinition),
        ObjectDefinitions,
        universalRecords(resolveDefinitions),
      ],
      endpoints: [...(config.endpoints ?? []), ...adapterEndpoints],
      onInit: async (payload) => {
        await previousOnInit?.(payload)
        await seedNexusRoles(payload)
      },
    }
    return withPluginMigrations(withPlugin, NEXUS_SPIKE_MIGRATIONS)
  }
}

export const standardSlugs = standardDefinitions.map(standardSlug)
export { NEXUS_RECORDS_SLUG }
