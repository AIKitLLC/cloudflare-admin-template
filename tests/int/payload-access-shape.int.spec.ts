// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getEntityPermissions } from 'payload/internal'
import { describe, expect, it } from 'vitest'

import { isPermissionPayloadCall } from '@/access/permission-payload-call'

const require = createRequire(import.meta.url)

type AccessInvoker = (
  args: { id?: unknown; data?: unknown; req: object },
  access: (args: object) => boolean,
) => Promise<unknown>

/**
 * Payload 3.91 calls collection access with two shapes. The permission-payload
 * shortcut treats exactly `{ id, collectionConfig, data, req }` as a permission
 * prop and every other shape as a query. An upgrade that changes either call
 * would flip that shortcut, so this test is pinned to 3.91.0 and invokes the
 * real functions.
 */
describe('Payload 3.91.0 access call shapes', () => {
  it('keeps executeAccess and getEntityPermissions on the shapes this branch expects', async () => {
    const payloadRoot = dirname(dirname(require.resolve('payload')))
    const payloadPackage = JSON.parse(readFileSync(join(payloadRoot, 'package.json'), 'utf8')) as {
      version: string
    }
    expect(payloadPackage.version).toBe('3.91.0')
    const { executeAccess } = (await import(
      pathToFileURL(join(payloadRoot, 'dist/auth/executeAccess.js')).href
    )) as { executeAccess: AccessInvoker }

    let queryKeys: string[] = []
    await executeAccess(
      { id: 1, data: { email: 'a@example.com' }, req: { user: { id: 1 } } },
      (args) => {
        queryKeys = Object.keys(args).sort()
        return true
      },
    )
    expect(queryKeys).toEqual(['collectionConfig', 'data', 'id', 'isReadingStaticFile', 'req'])
    expect(isPermissionPayloadCall(keysToArgs(queryKeys))).toBe(false)

    let permissionKeys: string[] = []
    await getEntityPermissions({
      entity: {
        slug: 'probe',
        access: {
          read: (args: object) => {
            permissionKeys = Object.keys(args).sort()
            return false
          },
        },
        fields: [],
      },
      entityType: 'collection',
      fetchData: false,
      operations: ['read'],
      req: { user: { id: 1 } },
    } as never)
    expect(permissionKeys).toEqual(['collectionConfig', 'data', 'id', 'req'])
    expect(isPermissionPayloadCall(keysToArgs(permissionKeys))).toBe(true)
  })
})

function keysToArgs(keys: string[]): Record<string, undefined> {
  const args: Record<string, undefined> = {}
  for (const key of keys) {
    args[key] = undefined
  }
  return args
}
