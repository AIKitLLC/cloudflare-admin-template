import type { Config, Payload, Plugin } from 'payload'

import { applyFieldAccess } from './access/fields/apply-field-access'
import { assertRbacCoverage, ensureRbacCoverage } from './access/ensure-rbac-coverage'
import { coverLiveConfig } from './access/cover-unwrapped'
import { rbacCoveragePlugin } from './access/rbac-coverage-plugin'
import { Permissions, syncPermissionActionOptions } from './rbac/collections/Permissions'
import { RolePermissions } from './rbac/collections/RolePermissions'
import { Roles } from './rbac/collections/Roles'
import { grantEndpoint, matrixEndpoint } from './rbac/endpoints/matrix-handlers'
import { seedRbac } from './rbac/seed/seed-rbac'

const matrixView = '@aikit/admin-rbac/admin#PermissionMatrixView'
const matrixLink = '@aikit/admin-rbac/admin#PermissionMatrixNavLink'

export const adminRbac = (): Plugin => (incoming) => {
  syncPermissionActionOptions()
  const collections = [...(incoming.collections ?? [])]
  const slugs = new Set(collections.map((collection) => collection.slug))
  if (!slugs.has(Roles.slug)) collections.push(Roles)
  if (!slugs.has(Permissions.slug)) collections.push(Permissions)
  if (!slugs.has(RolePermissions.slug)) collections.push(RolePermissions)

  const endpoints = [...(incoming.endpoints ?? [])]
  if (!endpoints.some((endpoint) => endpoint.path === matrixEndpoint.path)) {
    endpoints.push(matrixEndpoint, grantEndpoint)
  }

  const config: Config = {
    ...incoming,
    collections: ensureRbacCoverage(collections),
    endpoints,
    admin: {
      ...incoming.admin,
      components: {
        ...incoming.admin?.components,
        afterNavLinks: [
          ...(incoming.admin?.components?.afterNavLinks ?? []),
          matrixLink,
        ],
        views: {
          ...incoming.admin?.components?.views,
          permissionMatrix: {
            Component: matrixView,
            path: '/permission-matrix',
            exact: true,
            meta: {
              title: 'Permission Matrix',
            },
          },
        },
      },
    },
    onInit: async (payload: Payload) => {
      await incoming.onInit?.(payload)
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
  }
  return rbacCoveragePlugin(config)
}
