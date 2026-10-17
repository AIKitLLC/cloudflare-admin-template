import { Forbidden, type CollectionBeforeOperationHook, type PayloadRequest } from 'payload'

import { hasFirstAdminSetupClaim } from './first-admin-setup'

/**
 * `users` creation needs a signed-in user, the Local API, or an active first-run setup
 * claim. The first admin is created by the admin panel's create-first-user screen
 * (`POST /api/users/first-register`, see `first-admin-setup.ts`) or by `pnpm admin:create`.
 */
export function allowsUserCreation(
  req: Pick<PayloadRequest, 'payloadAPI' | 'user'>,
  context?: unknown,
): boolean {
  return req.payloadAPI === 'local' || Boolean(req.user) || hasFirstAdminSetupClaim(context)
}

export const guardPublicUserCreation: CollectionBeforeOperationHook = ({
  args,
  context,
  operation,
  req,
}) => {
  if (operation === 'create' && !allowsUserCreation(req, context ?? req.context)) {
    throw new Forbidden(req.t)
  }
  return args
}
