// @vitest-environment node
import type { CollectionConfig, GlobalConfig } from 'payload'
import { describe, expect, it } from 'vitest'

import { applyRbacToGlobal, applyRbacToUnwrappedCollection } from '@/access/cover-unwrapped'
import { collectionEnablesRbac } from '@/access/options'
import { resolvePublicServerURL } from '@/config/public-server-url'
import { assignSuperAdminToFirstUser } from '@/rbac/hooks/assign-super-admin-to-first-user'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/rbac/guards/privilege-context'

describe('RBAC coverage and production URL', () => {
  it('fails production startup when the public server URL is missing', () => {
    expect(() =>
      resolvePublicServerURL({
        configuredURL: '  ',
        isCLI: false,
        nextPhase: undefined,
        nodeEnv: 'production',
      }),
    ).toThrow(/PAYLOAD_PUBLIC_SERVER_URL is required in production/)
  })

  it('keeps the localhost fallback for dev, the CLI, and the Next production build', () => {
    expect(
      resolvePublicServerURL({
        configuredURL: undefined,
        isCLI: false,
        nextPhase: undefined,
        nodeEnv: 'development',
      }),
    ).toBe('http://localhost:3000')
    expect(
      resolvePublicServerURL({
        configuredURL: undefined,
        isCLI: true,
        nextPhase: undefined,
        nodeEnv: 'production',
      }),
    ).toBe('http://localhost:3000')
    expect(
      resolvePublicServerURL({
        configuredURL: undefined,
        isCLI: false,
        nextPhase: 'phase-production-build',
        nodeEnv: 'production',
      }),
    ).toBe('http://localhost:3000')
    expect(
      resolvePublicServerURL({
        configuredURL: ' https://admin.example.com ',
        isCLI: false,
        nextPhase: undefined,
        nodeEnv: 'production',
      }),
    ).toBe('https://admin.example.com')
  })

  it('replaces plugin collection access instead of leaving the logged-in default', () => {
    const read = () => true
    const collection = {
      slug: 'plugin-notes',
      fields: [{ name: 'title', type: 'text' as const }],
      access: { read, admin: () => true },
      endpoints: [] as NonNullable<CollectionConfig['endpoints']>,
    } as CollectionConfig
    applyRbacToUnwrappedCollection(collection)
    expect(collectionEnablesRbac(collection.custom)).toBe(true)
    expect(collection.access?.read).not.toBe(read)
    expect(collection.access?.admin).toBeDefined()
    const endpoints = Array.isArray(collection.endpoints) ? collection.endpoints : []
    expect(endpoints.some((endpoint) => endpoint.path === '/export')).toBe(true)
    applyRbacToUnwrappedCollection(collection)
    const again = Array.isArray(collection.endpoints) ? collection.endpoints : []
    expect(again.filter((endpoint) => endpoint.path === '/export')).toHaveLength(1)
  })

  it('replaces global access that would otherwise allow any logged-in user', () => {
    const read = () => true
    const globalConfig = {
      slug: 'site-settings',
      fields: [{ name: 'title', type: 'text' as const }],
      access: { read },
    } as GlobalConfig
    applyRbacToGlobal(globalConfig)
    expect(globalConfig.access.read).not.toBe(read)
    expect(globalConfig.access.update).toBeTypeOf('function')
    expect(collectionEnablesRbac(globalConfig.custom)).toBe(true)
  })

  it('creates the super-admin role when the first user arrives before seed', async () => {
    const updates: Array<{ data?: { roles?: unknown }; context?: Record<string, unknown> }> = []
    const req = {
      context: {} as Record<string, unknown>,
      payload: {
        find: async () => ({ docs: [] as Array<{ id: number }> }),
        create: async () => ({ id: 42, slug: 'super-admin', grantsFullAccess: true }),
        count: async () => ({ totalDocs: 1 }),
        update: async (args: {
          data?: { roles?: unknown }
          context?: Record<string, unknown>
          req?: { context?: Record<string, unknown> }
        }) => {
          updates.push(args)
          if (args.req) {
            args.req.context = { ...(args.req.context ?? {}), ...(args.context ?? {}) }
          }
          return { id: 7, roles: args.data?.roles }
        },
      },
    }
    const doc = await assignSuperAdminToFirstUser({
      collection: {} as never,
      context: {},
      doc: { id: 7, roles: [] },
      operation: 'create',
      previousDoc: {} as never,
      req: req as never,
    } as unknown as Parameters<typeof assignSuperAdminToFirstUser>[0])
    expect(updates).toHaveLength(1)
    expect(updates[0]?.data?.roles).toEqual([42])
    expect(updates[0]?.context?.[SKIP_RBAC_PRIVILEGE_CHECKS]).toBe(true)
    expect(updates[0]?.context?.skipRbacBootstrap).toBe(true)
    expect(req.context[SKIP_RBAC_PRIVILEGE_CHECKS]).toBeUndefined()
    expect(req.context.skipRbacBootstrap).toBeUndefined()
    expect(doc).toMatchObject({ roles: [42] })
  })
})
