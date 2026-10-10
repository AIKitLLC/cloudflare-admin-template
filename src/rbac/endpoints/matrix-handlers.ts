import type { CollectionSlug, Endpoint, PayloadRequest } from 'payload'

import { evaluateCollectionAccess } from '../../access/evaluate-collection-access'
import { ROLE_PERMISSIONS_SLUG, ROLES_SLUG } from '../../access/constants'
import { isAccessGranted } from '../../access/result'
import { loadPermissionMatrix } from '../matrix/load-permission-matrix'
import { setRoleGrant } from '../matrix/set-role-grant'
import { GRANT_ROUTE, MATRIX_ROUTE } from '../routes'

export const matrixEndpoint: Endpoint = {
  path: MATRIX_ROUTE,
  method: 'get',
  handler: async (req) => {
    const allowed = await authorize(req, 'read')
    if (allowed) {
      return allowed
    }
    const matrix = await loadPermissionMatrix(req.payload)
    const canEdit = isAccessGranted(
      await evaluateCollectionAccess({
        req,
        collectionSlug: ROLE_PERMISSIONS_SLUG,
        action: 'update',
      }),
    )
    return Response.json({ ...matrix, canEdit })
  },
}

export const grantEndpoint: Endpoint = {
  path: GRANT_ROUTE,
  method: 'post',
  handler: async (req) => {
    const allowed = await authorize(req, 'update')
    if (allowed) {
      return allowed
    }
    const body = (await req.json?.()) as {
      roleId?: unknown
      permissionId?: unknown
      granted?: unknown
    } | null
    const roleId = integerId(body?.roleId)
    const permissionId = integerId(body?.permissionId)
    if (roleId === undefined || permissionId === undefined || typeof body?.granted !== 'boolean') {
      return Response.json(
        { error: 'roleId, permissionId, and granted are required.' },
        { status: 400 },
      )
    }

    const role = await req.payload
      .findByID({
        collection: ROLES_SLUG as CollectionSlug,
        id: roleId,
        depth: 0,
        overrideAccess: true,
        disableErrors: true,
        req,
      })
      .catch((): null => null)
    if (!role) {
      return Response.json({ error: 'Role not found.' }, { status: 404 })
    }
    if ((role as { grantsFullAccess?: boolean | null }).grantsFullAccess) {
      return Response.json(
        { error: 'Full-access roles bypass the matrix and their grants stay locked.' },
        { status: 400 },
      )
    }

    await setRoleGrant(req.payload, {
      roleId,
      permissionId,
      granted: body.granted,
    })
    return Response.json({ ok: true, roleId, permissionId, granted: body.granted })
  },
}

async function authorize(
  req: PayloadRequest,
  action: 'read' | 'update',
): Promise<Response | undefined> {
  if (!req.user) {
    return Response.json({ error: 'Authentication is required.' }, { status: 401 })
  }
  const decision = await evaluateCollectionAccess({
    req,
    collectionSlug: ROLE_PERMISSIONS_SLUG,
    action,
  })
  if (!isAccessGranted(decision)) {
    return Response.json({ error: 'You cannot manage the permission matrix.' }, { status: 403 })
  }
  return undefined
}

function integerId(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined
  }
  return parsed
}
