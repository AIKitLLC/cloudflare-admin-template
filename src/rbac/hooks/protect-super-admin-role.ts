import type {
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionSlug,
} from 'payload'
import { APIError } from 'payload'

import { ROLES_SLUG, SUPER_ADMIN_SLUG } from '../../access/constants'
import { assertRemainingFullAccessHolder } from '../guards/guard-full-access-assignment'
import { assertCanChangeFullAccessFlag } from '../guards/guard-full-access-flag'
import { skipsPrivilegeChecks } from '../../access'

export const protectSuperAdminRole: CollectionBeforeChangeHook = async ({
  context,
  data,
  originalDoc,
  operation,
  req,
}) => {
  if (typeof data?.slug === 'string') {
    data.slug = data.slug.trim().toLowerCase()
  }
  await assertCanChangeFullAccessFlag({
    context,
    data: data ?? {},
    operation,
    originalDoc,
    req,
  })
  if (operation === 'update' && originalDoc?.slug === SUPER_ADMIN_SLUG) {
    if (data?.slug && data.slug !== SUPER_ADMIN_SLUG) {
      throw new APIError('The super-admin role slug cannot be changed.', 400)
    }
    if (data?.grantsFullAccess === false) {
      throw new APIError('The super-admin role must keep full access.', 400)
    }
    data.slug = SUPER_ADMIN_SLUG
    data.grantsFullAccess = true
  }
  return data
}

export const preventSuperAdminDeletion: CollectionBeforeDeleteHook = async ({
  context,
  id,
  req,
}) => {
  const role = (await req.payload.findByID({
    collection: ROLES_SLUG as CollectionSlug,
    id,
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })) as { grantsFullAccess?: boolean | null; slug?: string | null } | null
  if (role?.slug === SUPER_ADMIN_SLUG) {
    throw new APIError('The super-admin role cannot be deleted.', 400)
  }
  if (!role?.grantsFullAccess || skipsPrivilegeChecks(context) || !req.user) {
    return
  }
  await assertRemainingFullAccessHolder(req, String(id))
}
