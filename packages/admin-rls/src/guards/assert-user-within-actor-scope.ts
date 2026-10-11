import type { PayloadRequest } from 'payload'
import { APIError } from 'payload'

import { userGrantsFullAccess } from '@aikit/admin-rbac'
import { SCOPE_USER_ERROR } from '../errors'
import { loadEffectiveScope } from '../resolve/load-effective-scope'
import { assignmentsWithinScope } from './assignments-within-scope'

export async function assertUserWithinActorScope(
  req: PayloadRequest,
  target: unknown,
): Promise<void> {
  if (!req.user || target == null || typeof target !== 'object') {
    return
  }
  const targetId = (target as { id?: unknown }).id
  if (targetId != null && String(targetId) === String(req.user.id)) {
    return
  }
  if (await userGrantsFullAccess(req)) {
    return
  }
  const scope = await loadEffectiveScope(req)
  if (!assignmentsWithinScope(target, scope)) {
    throw new APIError(SCOPE_USER_ERROR, 403)
  }
}
