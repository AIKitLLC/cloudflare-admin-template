import type { PayloadRequest } from 'payload'

import { readRbacCollectionOptions } from '../../access/options'
import { policyGate } from '../../access/gates/policy-gate'
import { unauthenticatedGate } from '../../access/gates/unauthenticated-gate'
import { loadUserGrants } from '../../access/resolve/load-user-grants'
import { JOBS_RETRY_KEY, JOBS_SLUG, JOBS_TRIGGER_KEY } from '../constants'

export async function evaluateJobDispatch(
  req: PayloadRequest,
  action: 'trigger' | 'retry',
): Promise<boolean> {
  const grants = await loadUserGrants(req)
  const context = {
    req,
    collectionSlug: JOBS_SLUG,
    action: action === 'trigger' ? ('create' as const) : ('update' as const),
    grants,
    options: readRbacCollectionOptions(req, JOBS_SLUG),
  }
  if ((await policyGate.evaluate(context)) === false) {
    return false
  }
  if ((await unauthenticatedGate.evaluate(context)) === false) {
    return false
  }
  if (grants?.fullAccess) {
    return true
  }
  const key = action === 'trigger' ? JOBS_TRIGGER_KEY : JOBS_RETRY_KEY
  return grants?.permissionKeys.has(key) === true
}
