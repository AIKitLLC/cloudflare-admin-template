import fs from 'fs'
import path from 'path'
import { sqliteD1Adapter } from '@payloadcms/db-d1-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig, type CollectionConfig, type PayloadLogger } from 'payload'
import { fileURLToPath } from 'url'
import { CloudflareContext, getCloudflareContext } from '@opennextjs/cloudflare'
import { GetPlatformProxyOptions } from 'wrangler'
import { r2Storage } from '@payloadcms/storage-r2'

import {
  applyFieldAccess,
  assertRbacCoverage,
  coverLiveConfig,
  ensureRbacCoverage,
  rbacCoveragePlugin,
} from './access'
import { AuditLogs, withAuditTrail } from './audit'
import { ClientSecurityCollections, LoginThrottle, Media, SetupState, Users } from './collections'
import { resolvePublicServerURL } from './config/public-server-url'
import { testRuntimeStorageDir, testRuntimeWranglerConfig } from './config/test-runtime'
import { Jobs, retryJobMutation } from './jobs'
import { migrations } from './migrations'
import {
  Permissions,
  RolePermissions,
  Roles,
  grantEndpoint,
  matrixEndpoint,
  seedRbac,
} from './rbac'
import {
  Branches,
  DataClasses,
  Organizations,
  Records,
  assertRowScopeHooks,
  ensureRowScopeRegistered,
} from './scope'
import { SystemParameters } from './system-parameters'

/**
 * Vitest setup assigns this before the config module loads. Production and
 * `payload generate:types` leave it unset, so the test collection stays out of
 * the shipped config and `payload-types.ts`.
 */
function testOnlyCollections(): CollectionConfig[] {
  const holder = globalThis as typeof globalThis & {
    __payloadTestCollections?: CollectionConfig[]
  }
  return holder.__payloadTestCollections ?? []
}

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const realpath = (value: string) => (fs.existsSync(value) ? fs.realpathSync(value) : undefined)

const isCLI = process.argv.some((value) =>
  realpath(value)?.endsWith(path.join('payload', 'bin.js')),
)
const isProduction = process.env.NODE_ENV === 'production'
const isTest = process.env.NODE_ENV === 'test'
// `next build` sets NODE_ENV=production. The D1 binding is marked remote, so a
// production platform proxy would open a Cloudflare session and the build could
// not run without an API token. Use the local proxy for that phase only.
const isNextProductionBuild = process.env.NEXT_PHASE === 'phase-production-build'
// Set only by integration tests that start `next dev` against their isolated local
// D1/R2 runtime. Next.js inlines NODE_ENV=development there, so it is not `isTest`.
const testWranglerConfig = testRuntimeWranglerConfig({
  nodeEnv: process.env.NODE_ENV,
  wranglerConfig: process.env.PAYLOAD_TEST_WRANGLER_CONFIG,
})
const testStorageDir = testRuntimeStorageDir({
  nodeEnv: process.env.NODE_ENV,
  storageDir: process.env.PAYLOAD_TEST_STORAGE_DIR,
})
const serverURL = resolvePublicServerURL({
  configuredURL: process.env.PAYLOAD_PUBLIC_SERVER_URL,
  isCLI,
  nextPhase: process.env.NEXT_PHASE,
  nodeEnv: process.env.NODE_ENV,
})
const allowedOrigins = [
  serverURL,
  ...(process.env.PAYLOAD_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
]

const createLog =
  (level: string, fn: typeof console.log) => (objOrMsg: object | string, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      fn(JSON.stringify({ level, msg: objOrMsg }))
    } else {
      fn(JSON.stringify({ level, ...objOrMsg, msg: msg ?? (objOrMsg as { msg?: string }).msg }))
    }
  }

const cloudflareLogger = {
  level: process.env.PAYLOAD_LOG_LEVEL || 'info',
  trace: createLog('trace', console.debug),
  debug: createLog('debug', console.debug),
  info: createLog('info', console.log),
  warn: createLog('warn', console.warn),
  error: createLog('error', console.error),
  fatal: createLog('fatal', console.error),
  silent: () => {},
} as unknown as PayloadLogger // Minimal JSON logger; not a full pino instance

const cloudflare = isTest
  ? await getCloudflareContext({ async: true })
  : isCLI || !isProduction || isNextProductionBuild
    ? await getCloudflareContextFromWrangler()
    : await getCloudflareContext({ async: true })

ensureRowScopeRegistered()

const collections: CollectionConfig[] = [
  Users,
  Media,
  ...ClientSecurityCollections,
  LoginThrottle,
  SetupState,
  Roles,
  Permissions,
  RolePermissions,
  Organizations,
  Branches,
  DataClasses,
  Records,
  withAuditTrail(SystemParameters),
  withAuditTrail(Jobs),
  AuditLogs,
  ...testOnlyCollections(),
]
assertRowScopeHooks(collections)

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
    components: {
      afterNavLinks: [
        '/client-security/admin/ClientSecurityNav#ClientSecurityNav',
        '/rbac/admin/PermissionMatrixNavLink#PermissionMatrixNavLink',
        '/jobs/admin/JobsNavLink#JobsNavLink',
      ],
      views: {
        clientSecurity: {
          Component: '/client-security/admin/ClientSecurityView#ClientSecurityView',
          path: '/client-security',
        },
        permissionMatrix: {
          Component: '/rbac/admin/PermissionMatrixView#PermissionMatrixView',
          path: '/permission-matrix',
          exact: true,
          meta: {
            title: 'Permission Matrix',
          },
        },
        jobMonitor: {
          Component: '/jobs/admin/JobsDashboardView#JobsDashboardView',
          path: '/job-monitor',
          exact: true,
          meta: {
            title: 'Job Monitor',
          },
        },
      },
    },
  },
  collections: ensureRbacCoverage(collections),
  endpoints: [matrixEndpoint, grantEndpoint],
  graphQL: {
    mutations: retryJobMutation,
  },
  serverURL,
  // One file per upload, at most 5 MiB; a larger one answers 413 before it reaches R2 (#72).
  upload: { limits: { fileSize: 5 * 1024 * 1024 } },
  cors: allowedOrigins,
  csrf: allowedOrigins,
  onInit: async (payload) => {
    coverLiveConfig(payload)
    applyFieldAccess(payload)
    assertRbacCoverage(payload)
    // Plugins can add row-scoped collections after the module-load check; verify the final list.
    assertRowScopeHooks(payload.config.collections)
    try {
      await seedRbac(payload)
    } catch (error) {
      payload.logger.error({
        msg: 'RBAC seed failed. Requests continue with the last successful catalog.',
        err: error,
      })
    }
  },
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: sqliteD1Adapter({
    binding: cloudflare.env.D1,
    prodMigrations: migrations,
  }),
  logger: isProduction ? cloudflareLogger : undefined,
  plugins: [
    r2Storage({
      bucket: cloudflare.env.R2,
      collections: { media: true },
    }),
    rbacCoveragePlugin,
  ],
})

// Adapted from https://github.com/opennextjs/opennextjs-cloudflare/blob/d00b3a13e42e65aad76fba41774815726422cc39/packages/cloudflare/src/api/cloudflare-context.ts#L328C36-L328C46
function getCloudflareContextFromWrangler(): Promise<CloudflareContext> {
  const isTestRuntime = isTest || Boolean(testWranglerConfig)
  if (isTestRuntime && !testStorageDir) {
    throw new Error('Integration tests require isolated PAYLOAD_TEST_STORAGE_DIR')
  }
  return import(/* webpackIgnore: true */ `${'__wrangler'.replaceAll('_', '')}`).then(
    ({ getPlatformProxy }) =>
      getPlatformProxy({
        environment: isTestRuntime ? undefined : process.env.CLOUDFLARE_ENV,
        // Build-time inspection must not contact the configured production D1 database.
        remoteBindings: isTestRuntime ? false : isProduction && !isNextProductionBuild,
        ...(isTestRuntime
          ? {
              configPath: testWranglerConfig,
              persist: { path: testStorageDir! },
              envFiles: [],
            }
          : {}),
      } satisfies GetPlatformProxyOptions),
  )
}
