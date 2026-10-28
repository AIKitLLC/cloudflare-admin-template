// @vitest-environment node
// THROWAWAY spike for #44. Measures variants a, b, c and the hybrid on the real config. Never merges.
import { createLocalReq, getPayload, type CollectionSlug, type Config, type Payload, type PayloadRequest } from 'payload'
import { sqliteD1Adapter } from '@payloadcms/db-d1-sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { uncoveredCollectionSlugs } from '@/access/ensure-rbac-coverage'
import { adapterEndpoints } from '../../spike/nexus-crm/variant-c-adapter'
import { NEXUS_ROLES, withPluginMigrations } from '../../spike/nexus-crm/plugin'

let payload: Payload
const stamp = Date.now()
const userIds: Array<number | string> = []
const docs: Array<[string, number | string]> = []

const slug = (value: string) => value as CollectionSlug

async function roleId(roleSlug: string): Promise<number> {
  const found = await payload.find({ collection: slug('roles'), depth: 0, limit: 1, overrideAccess: true, where: { slug: { equals: roleSlug } } })
  if (!found.docs[0]) throw new Error(`role ${roleSlug} missing`)
  return Number(found.docs[0].id)
}

async function userWith(roleSlug: string, extraRoleIds: number[] = []) {
  const user = await payload.create({
    collection: 'users',
    data: { role: 'admin', email: `nexus-${roleSlug}-${stamp}-${userIds.length}@example.com`, password: 'test-password-123', roles: [await roleId(roleSlug), ...extraRoleIds] },
    overrideAccess: true,
  })
  userIds.push(user.id)
  return user
}

const asUser = (user: unknown) => ({ overrideAccess: false as const, user: user as never })

async function req(user: unknown, body?: unknown): Promise<PayloadRequest> {
  const local = await createLocalReq({ user: user as PayloadRequest['user'] }, payload)
  if (body) local.json = async () => body
  return local
}

describe('nexus spike: coverage and catalog', () => {
  beforeAll(async () => {
    const { default: config } = await import('@/payload.config')
    payload = await getPayload({ config })
  }, 120000)

  afterAll(async () => {
    if (!payload) return
    for (const [collection, id] of docs.reverse()) {
      await payload.delete({ collection: slug(collection), id, overrideAccess: true }).catch((): undefined => undefined)
    }
    if (userIds.length) await payload.delete({ collection: 'users', where: { id: { in: userIds } }, overrideAccess: true })
  }, 120000)

  it('boots with every nexus collection covered by RBAC (ensure-rbac-coverage ran in onInit)', () => {
    expect(uncoveredCollectionSlugs(payload.config.collections)).toEqual([])
    const nexus = payload.config.collections.map((c) => c.slug).filter((s) => s.startsWith('nexus_'))
    expect(nexus.sort()).toEqual(['nexus_contacts', 'nexus_deals', 'nexus_object_definitions', 'nexus_records'])
  })

  it('measures catalog size per variant', async () => {
    const all = await payload.find({ collection: slug('permissions'), depth: 0, limit: 1000, pagination: false, overrideAccess: true, where: { collectionSlug: { like: 'nexus_' } } })
    const bySlug: Record<string, string[]> = {}
    for (const doc of all.docs as unknown as { key: string; collectionSlug: string }[]) (bySlug[doc.collectionSlug] ??= []).push(doc.key)
    const counts = Object.fromEntries(Object.entries(bySlug).map(([k, v]) => [k, v.length]))
    console.log('[measure] permission rows per collection', JSON.stringify(counts))
    const tables = Object.keys((payload.db as unknown as { tables: Record<string, object> }).tables).filter((t) => t.startsWith('nexus_'))
    console.log('[measure] drizzle tables', JSON.stringify(tables))
    expect(bySlug.nexus_contacts).toContain('nexus_contacts:readField:email')
    expect(bySlug.nexus_deals).toContain('nexus_deals:writeField:amount')
    // variant b: a JSON blob is one permissioned field, so there is no per-attribute key.
    expect(bySlug.nexus_records.filter((k) => k.includes('Field')).sort()).toContain('nexus_records:readField:data')
    expect(bySlug.nexus_records.some((k) => k.includes(':email'))).toBe(false)
    // variant c: only what the contributor registered.
    expect(bySlug.nexus_adapter_records.sort()).toEqual(['nexus_adapter_records:create', 'nexus_adapter_records:read'])
  })

  it('seeds the five nexus roles as normal roles (owner is not full access)', async () => {
    for (const seed of NEXUS_ROLES) {
      const found = await payload.find({ collection: slug('roles'), depth: 0, limit: 1, overrideAccess: true, where: { slug: { equals: seed.slug } } })
      expect(found.docs[0], seed.slug).toBeTruthy()
      expect((found.docs[0] as { grantsFullAccess?: boolean }).grantsFullAccess).toBe(false)
    }
  })

  it('variant a: owner creates and lists contacts and deals; viewer can read but not create; field access strips email', async () => {
    const owner = await userWith('nexus-owner')
    const contact = await payload.create({ collection: slug('nexus_contacts'), data: { name: 'Ada Lovelace', email: 'ada@example.test', lifecycle: 'lead' } as never, ...asUser(owner) })
    docs.push(['nexus_contacts', contact.id])
    const deal = await payload.create({ collection: slug('nexus_deals'), data: { title: 'Analytical Engine', stage: 'new', amount: 1200, contact: contact.id } as never, ...asUser(owner) })
    docs.push(['nexus_deals', deal.id])
    const list = await payload.find({ collection: slug('nexus_deals'), depth: 1, ...asUser(owner) })
    expect(list.docs.some((d) => (d as { id: number | string }).id === deal.id)).toBe(true)

    const viewer = await userWith('nexus-viewer')
    const seen = await payload.find({ collection: slug('nexus_contacts'), ...asUser(viewer) })
    expect(seen.totalDocs).toBeGreaterThan(0)
    await expect(payload.create({ collection: slug('nexus_contacts'), data: { name: 'Nope' } as never, ...asUser(viewer) })).rejects.toThrow(/not allowed/i)

    // Field-level RBAC: a role without readField:email gets the doc minus that field.
    const noEmail = await payload.create({ collection: slug('roles'), data: { slug: `no-email-${stamp}`, name: 'no email', grantsFullAccess: false }, overrideAccess: true })
    docs.push(['roles', noEmail.id])
    for (const key of ['nexus_contacts:read', 'nexus_contacts:readField:name']) {
      const permission = await payload.find({ collection: slug('permissions'), depth: 0, limit: 1, overrideAccess: true, where: { key: { equals: key } } })
      const rp = await payload.create({ collection: slug('role-permissions'), data: { role: noEmail.id, permission: permission.docs[0].id, granted: true }, overrideAccess: true })
      docs.push(['role-permissions', rp.id])
    }
    const limited = await payload.create({ collection: 'users', data: { role: 'admin', email: `nexus-noemail-${stamp}@example.com`, password: 'test-password-123', roles: [noEmail.id] }, overrideAccess: true })
    userIds.push(limited.id)
    const trimmed = await payload.findByID({ collection: slug('nexus_contacts'), id: contact.id, ...asUser(limited) })
    expect((trimmed as { name?: string }).name).toBe('Ada Lovelace')
    expect((trimmed as { email?: string }).email).toBeUndefined()
  })

  it('variant b / hybrid: a custom object defined at runtime needs no migration; validation is hand-written', async () => {
    const owner = await userWith('nexus-owner')
    const definition = await payload.create({
      collection: slug('nexus_object_definitions'),
      data: {
        key: `vehicle${stamp}`, singular: 'Vehicle', plural: 'vehicles', titleField: 'plate',
        fields: [
          { key: 'plate', label: 'Plate', type: 'text', required: true },
          { key: 'kind', label: 'Kind', type: 'select', options: ['car', 'bike'] },
        ],
      } as never,
      ...asUser(owner),
    })
    docs.push(['nexus_object_definitions', definition.id])
    const record = await payload.create({ collection: slug('nexus_records'), data: { objectKey: `vehicle${stamp}`, data: { plate: 'ABC-123', kind: 'car' } } as never, ...asUser(owner) })
    docs.push(['nexus_records', record.id])
    expect((record as { title?: string }).title).toBe('ABC-123')
    await expect(payload.create({ collection: slug('nexus_records'), data: { objectKey: `vehicle${stamp}`, data: { plate: 'X', kind: 'boat' } } as never, ...asUser(owner) })).rejects.toThrow()
    await expect(payload.create({ collection: slug('nexus_records'), data: { objectKey: 'nope', data: {} } as never, ...asUser(owner) })).rejects.toThrow()

    // Same contact stored the variant-b way: queryable by indexed columns, not by data attributes.
    const asRecord = await payload.create({ collection: slug('nexus_records'), data: { objectKey: 'contact', data: { name: 'Grace Hopper', email: 'grace@example.test', lifecycle: 'customer' } } as never, ...asUser(owner) })
    docs.push(['nexus_records', asRecord.id])
    const byTitle = await payload.find({ collection: slug('nexus_records'), where: { and: [{ objectKey: { equals: 'contact' } }, { title: { equals: 'Grace Hopper' } }] }, ...asUser(owner) })
    expect(byTitle.totalDocs).toBe(1)
    const byAttr = await payload.find({ collection: slug('nexus_records'), where: { 'data.lifecycle': { equals: 'customer' } }, ...asUser(owner) }).then(
      (result) => `ok(${result.totalDocs})`,
      (error: Error) => `error: ${error.message.slice(0, 80)}`,
    )
    console.log('[measure] filter on a JSON attribute (data.lifecycle) ->', byAttr)
  })

  it('variant c: endpoint list/create honours RBAC but there is no collection behind it', async () => {
    const [list, create] = [adapterEndpoints.find((e) => e.method === 'get')!, adapterEndpoints.find((e) => e.method === 'post')!]
    const owner = await userWith('nexus-owner')
    const created = await create.handler(await req(owner, { objectKey: 'contact', title: 'Linus', data: { email: 'l@example.test' } }))
    expect(created.status).toBe(201)
    const listed = await list.handler(await req(owner))
    expect(((await listed.json()) as { docs: unknown[] }).docs.length).toBeGreaterThan(0)
    const stranger = await payload.create({ collection: 'users', data: { role: 'admin', email: `nexus-none-${stamp}@example.com`, password: 'test-password-123', roles: [] }, overrideAccess: true })
    userIds.push(stranger.id)
    await expect(list.handler(await req(stranger))).rejects.toThrow()
    expect(payload.config.collections.some((c) => (c.slug as string) === 'nexus_adapter_records')).toBe(false)
  })

  it('a plugin can append migrations to the D1 adapter by wrapping config.db.init', () => {
    const base = { db: sqliteD1Adapter({ binding: {} as never, prodMigrations: [{ name: 'template_1', up: async () => {}, down: async () => {} }] }) } as unknown as Config
    const wrapped = withPluginMigrations(base, [{ name: 'nexus_1', up: async () => {}, down: async () => {} }])
    const adapter = (wrapped.db as unknown as { init: (a: { payload: Payload }) => { prodMigrations: { name: string }[] } }).init({ payload: {} as Payload })
    expect(adapter.prodMigrations.map((m) => m.name)).toEqual(['template_1', 'nexus_1'])
  })
})
