import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Payload } from 'payload'
import type { PlatformProxy } from 'wrangler'

import { createFirebaseFixture, firebaseFixtureEnv } from './firebase-fixture'

const contextSymbol = Symbol.for('__cloudflare-context__')
const scope = globalThis as typeof globalThis & { [contextSymbol]: unknown }
const previousContext = scope[contextSymbol]
const originalFetch = globalThis.fetch
const ownedEnvironmentVariables = [
  'NODE_ENV',
  'PAYLOAD_SECRET',
  'PAYLOAD_PUBLIC_SERVER_URL',
  'CLOUDFLARE_SEND_METRICS',
] as const
// A mutable view permits test-only NODE_ENV changes despite Next's readonly declaration.
const scopedEnvironment: Record<string, string | undefined> = process.env
let originalEnvironment:
  Record<(typeof ownedEnvironmentVariables)[number], string | undefined> | undefined
let platform: PlatformProxy<CloudflareEnv> | undefined
let directory: string | undefined
let payload: Payload | undefined
let fixture: Awaited<ReturnType<typeof createFirebaseFixture>>
let context: { env: CloudflareEnv & typeof firebaseFixtureEnv; cf: { colo: string } }

export async function startLocalIntegrationRuntime(): Promise<void> {
  try {
    originalEnvironment = Object.fromEntries(
      ownedEnvironmentVariables.map((name) => [name, scopedEnvironment[name]]),
    ) as NonNullable<typeof originalEnvironment>
    scopedEnvironment.PAYLOAD_SECRET =
      'synthetic-local-integration-secret-never-used-for-deployment'
    scopedEnvironment.CLOUDFLARE_SEND_METRICS = 'false'
    // Fixture origin used by the integration requests; Payload CORS/CSRF trust this origin.
    scopedEnvironment.PAYLOAD_PUBLIC_SERVER_URL = 'https://admin.fixture.invalid'
    directory = await mkdtemp(join(tmpdir(), 'template-payload-int-'))
    fixture = await createFirebaseFixture()
    const configPath = join(directory, 'wrangler.json')
    await writeFile(
      configPath,
      JSON.stringify({
        name: 'template-local-integration',
        compatibility_date: '2025-08-15',
        compatibility_flags: ['nodejs_compat'],
        d1_databases: [
          {
            binding: 'D1',
            database_name: 'integration-only',
            database_id: '00000000-0000-0000-0000-000000000000',
          },
        ],
        r2_buckets: [{ binding: 'R2', bucket_name: 'integration-only' }],
      }),
    )
    // Payload's R2 adapter selects its supported Miniflare response path at module load.
    // Load that actual development path; restore test mode before importing app config.
    // See storage-r2/dist/staticHandler.js: native writeHttpMetadata cannot accept proxy Headers.
    scopedEnvironment.NODE_ENV = 'development'
    try {
      await import('@payloadcms/storage-r2')
    } finally {
      scopedEnvironment.NODE_ENV = 'test'
    }
    const { getPlatformProxy } = await import('wrangler')
    platform = await getPlatformProxy<CloudflareEnv>({
      configPath,
      envFiles: [],
      remoteBindings: false,
      persist: { path: join(directory, 'state') },
    })
    // Synthetic trusted edge metadata for this isolated adapter test, never a deployment setting.
    context = {
      ...platform,
      env: { ...platform.env, ...firebaseFixtureEnv },
      cf: { colo: 'LOCAL' },
    }
    scope[contextSymbol] = context
    // The real native authenticator captures this fetch before the app module imports.
    // Public-key requests receive ephemeral fixtures; no Firebase provider is contacted.
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      const body =
        url.href === 'https://firebaseappcheck.googleapis.com/v1/jwks'
          ? fixture.jwks
          : url.href ===
              'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
            ? fixture.certificates
            : undefined
      if (body) return Response.json(body, { headers: { 'Cache-Control': 'max-age=3600' } })
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        throw new Error('Integration tests prohibit external fetches')
      }
      return originalFetch(input, init)
    }
  } catch (error) {
    await disposeLocalIntegrationRuntime()
    throw error
  }
}

export function localIntegrationRuntime() {
  return { platform: platform!, directory: directory!, fixture, env: context.env }
}

export function registerIntegrationPayload(value: Payload): void {
  payload = value
}

export async function disposeLocalIntegrationRuntime(): Promise<void> {
  try {
    await payload?.destroy()
  } finally {
    globalThis.fetch = originalFetch
    if (previousContext === undefined) delete scope[contextSymbol]
    else scope[contextSymbol] = previousContext
    try {
      await platform?.dispose()
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true })
      } finally {
        if (originalEnvironment) {
          for (const name of ownedEnvironmentVariables) {
            const value = originalEnvironment[name]
            if (value === undefined) delete scopedEnvironment[name]
            else scopedEnvironment[name] = value
          }
          originalEnvironment = undefined
        }
      }
    }
  }
}
