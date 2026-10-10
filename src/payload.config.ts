import fs from 'fs'
import path from 'path'
import { sqliteD1Adapter } from '@payloadcms/db-d1-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'
import { CloudflareContext, getCloudflareContext } from '@opennextjs/cloudflare'
import { GetPlatformProxyOptions } from 'wrangler'
import { r2Storage } from '@payloadcms/storage-r2'

import { coverLiveConfig } from './access/cover-unwrapped'
import { assertRbacCoverage, ensureRbacCoverage } from './access/ensure-rbac-coverage'
import { applyFieldAccess } from './access/fields/apply-field-access'
import { rbacCoveragePlugin } from './access/rbac-coverage-plugin'
import { resolvePublicServerURL } from './config/public-server-url'
import { Users } from './collections/Users'
import { Media } from './collections/Media'
import { Branches } from './scope/collections/Branches'
import { DataClasses } from './scope/collections/DataClasses'
import { Organizations } from './scope/collections/Organizations'
import { Records } from './scope/collections/Records'
import { WorkNotes } from './scope/collections/WorkNotes'
import { ensureRowScopeRegistered } from './scope/register-row-scope'
import { migrations } from './migrations'
import { Permissions } from './rbac/collections/Permissions'
import { RolePermissions } from './rbac/collections/RolePermissions'
import { Roles } from './rbac/collections/Roles'
import { grantEndpoint, matrixEndpoint } from './rbac/endpoints/matrix-handlers'
import { seedRbac } from './rbac/seed/seed-rbac'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const realpath = (value: string) => (fs.existsSync(value) ? fs.realpathSync(value) : undefined)

const isCLI = process.argv.some((value) =>
  realpath(value)?.endsWith(path.join('payload', 'bin.js')),
)
const isProduction = process.env.NODE_ENV === 'production'
const isNextProductionBuild = process.env.NEXT_PHASE === 'phase-production-build'
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
} as any // Use PayloadLogger type when it's exported

const cloudflare =
  isCLI || !isProduction || isNextProductionBuild
    ? await getCloudflareContextFromWrangler()
    : await getCloudflareContext({ async: true })

ensureRowScopeRegistered()

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
    components: {
      afterNavLinks: ['/components/rbac/PermissionMatrixNavLink#PermissionMatrixNavLink'],
      views: {
        permissionMatrix: {
          Component: '/components/rbac/PermissionMatrixView#PermissionMatrixView',
          path: '/permission-matrix',
          exact: true,
          meta: {
            title: 'Permission Matrix',
          },
        },
      },
    },
  },
  collections: ensureRbacCoverage([
    Users,
    Media,
    Roles,
    Permissions,
    RolePermissions,
    Organizations,
    Branches,
    DataClasses,
    Records,
    WorkNotes,
  ]),
  endpoints: [matrixEndpoint, grantEndpoint],
  serverURL,
  cors: allowedOrigins,
  csrf: allowedOrigins,
  onInit: async (payload) => {
    coverLiveConfig(payload)
    applyFieldAccess(payload)
    assertRbacCoverage(payload)
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
  return import(/* webpackIgnore: true */ `${'__wrangler'.replaceAll('_', '')}`).then(
    ({ getPlatformProxy }) =>
      getPlatformProxy({
        environment: process.env.CLOUDFLARE_ENV,
        remoteBindings: isProduction && !isNextProductionBuild,
      } satisfies GetPlatformProxyOptions),
  )
}
