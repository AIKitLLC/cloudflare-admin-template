// Variant (c): keep a nexus-shaped table outside Payload's schema and expose it through custom endpoints.
// There is no Payload collection, so there is no admin list/create view, no catalog row and no field access
// unless each of those is rebuilt by hand. This file is the smallest version that still honours RBAC.
import type { Endpoint, PayloadRequest } from 'payload'

import { assertCollectionAction, permissionKey } from '../../src/access'
import { registerCatalogContributor } from '../../src/rbac'

export const ADAPTER_SLUG = 'nexus_adapter_records'

export const CREATE_ADAPTER_TABLE = `CREATE TABLE IF NOT EXISTS nexus_adapter_records (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
)`

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

type Run = { rows?: Record<string, unknown>[]; results?: Record<string, unknown>[] }
const run = async (req: PayloadRequest, raw: string): Promise<Record<string, unknown>[]> => {
  const result = (await (req.payload.db as unknown as { execute: (a: { drizzle: unknown; raw: string }) => Promise<Run>; drizzle: unknown }).execute({ drizzle: (req.payload.db as unknown as { drizzle: unknown }).drizzle, raw })) as Run
  return result.rows ?? result.results ?? []
}

// RBAC catalog entries must be registered by hand because no collection declares them.
export function registerAdapterPermissions(): void {
  registerCatalogContributor({
    definitions: () =>
      (['read', 'create'] as const).map((action) => ({
        key: permissionKey(ADAPTER_SLUG, action),
        label: `Nexus Adapter Record · ${action}`,
        groupLabel: 'Nexus Adapter Record',
        collectionSlug: ADAPTER_SLUG,
        action,
      })),
  })
}

export const adapterEndpoints: Endpoint[] = [
  {
    path: '/nexus/adapter/records',
    method: 'get',
    handler: async (req) => {
      await assertCollectionAction({ req, collectionSlug: ADAPTER_SLUG, action: 'read' })
      await run(req, CREATE_ADAPTER_TABLE)
      const rows = await run(req, 'SELECT id, object_key, title, status, data_json FROM nexus_adapter_records ORDER BY created_at DESC LIMIT 50')
      return Response.json({ docs: rows })
    },
  },
  {
    path: '/nexus/adapter/records',
    method: 'post',
    handler: async (req) => {
      await assertCollectionAction({ req, collectionSlug: ADAPTER_SLUG, action: 'create' })
      const body = (await req.json?.()) as { objectKey: string; title: string; data?: unknown }
      await run(req, CREATE_ADAPTER_TABLE)
      const id = crypto.randomUUID()
      await run(
        req,
        `INSERT INTO nexus_adapter_records (id, object_key, title, data_json, created_at) VALUES (${quote(id)}, ${quote(body.objectKey)}, ${quote(body.title)}, ${quote(JSON.stringify(body.data ?? {}))}, ${quote(new Date().toISOString())})`,
      )
      return Response.json({ id }, { status: 201 })
    },
  },
]
