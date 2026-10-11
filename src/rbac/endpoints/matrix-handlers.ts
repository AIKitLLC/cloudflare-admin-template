import type { CollectionSlug, Endpoint, PayloadRequest } from 'payload'

import { evaluateCollectionAccess } from '../../access/evaluate-collection-access'
import { PERMISSIONS_SLUG, ROLE_PERMISSIONS_SLUG, ROLES_SLUG } from '../../access/constants'
import { isAccessGranted, isUnconditionalAllow } from '../../access/result'
import { assertMayChangeRoleGrant } from '../guards/guard-role-grants'
import { UNCONDITIONAL_GRANT_ERROR } from '../guards/privilege-errors'
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
    const [createDecision, updateDecision] = await Promise.all([
      evaluateCollectionAccess({
        req,
        collectionSlug: ROLE_PERMISSIONS_SLUG,
        action: 'create',
      }),
      evaluateCollectionAccess({
        req,
        collectionSlug: ROLE_PERMISSIONS_SLUG,
        action: 'update',
      }),
    ])
    const canEdit = isUnconditionalAllow(createDecision) && isUnconditionalAllow(updateDecision)
    return Response.json({ ...matrix, canEdit })
  },
}

export const grantEndpoint: Endpoint = {
  path: GRANT_ROUTE,
  method: 'post',
  handler: async (req) => {
    const createAllowed = await authorize(req, 'create')
    if (createAllowed) {
      return createAllowed
    }
    const updateAllowed = await authorize(req, 'update')
    if (updateAllowed) {
      return updateAllowed
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

    const [role, permission] = await Promise.all([
      req.payload
        .findByID({
          collection: ROLES_SLUG as CollectionSlug,
          id: roleId,
          depth: 0,
          overrideAccess: true,
          disableErrors: true,
          req,
        })
        .catch((): null => null),
      req.payload
        .findByID({
          collection: PERMISSIONS_SLUG as CollectionSlug,
          id: permissionId,
          depth: 0,
          overrideAccess: true,
          disableErrors: true,
          req,
        })
        .catch((): null => null),
    ])
    if (!role) {
      return Response.json({ error: 'Role not found.' }, { status: 404 })
    }
    if (!permission) {
      return Response.json({ error: 'Permission not found.' }, { status: 404 })
    }
    if ((role as { grantsFullAccess?: boolean | null }).grantsFullAccess) {
      return Response.json(
        { error: 'Full-access roles bypass the matrix and their grants stay locked.' },
        { status: 400 },
      )
    }
    try {
      await assertMayChangeRoleGrant({ permissionIds: [permissionId], req, roleId })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'You cannot change this grant.'
      return Response.json({ error: message }, { status: 403 })
    }

    await setRoleGrant(
      req.payload,
      {
        roleId,
        permissionId,
        granted: body.granted,
      },
      req,
    )
    return Response.json({ ok: true, roleId, permissionId, granted: body.granted })
  },
}

async function authorize(
  req: PayloadRequest,
  action: 'read' | 'create' | 'update',
): Promise<Response | undefined> {
  if (!req.user) {
    return Response.json({ error: 'Authentication is required.' }, { status: 401 })
  }
  const decision = await evaluateCollectionAccess({
    req,
    collectionSlug: ROLE_PERMISSIONS_SLUG,
    action,
  })
  if (action === 'read') {
    if (!isAccessGranted(decision)) {
      return Response.json({ error: 'You cannot manage the permission matrix.' }, { status: 403 })
    }
    return undefined
  }
  if (!isUnconditionalAllow(decision)) {
    return Response.json({ error: UNCONDITIONAL_GRANT_ERROR }, { status: 403 })
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
