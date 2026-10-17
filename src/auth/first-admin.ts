import { Forbidden, type CollectionBeforeOperationHook, type PayloadRequest } from 'payload'

/**
 * `users` creation needs a signed-in user or the Local API. The first admin is created
 * with `pnpm admin:create` (scripts/create-first-admin.mjs), so the admin panel's
 * create-first-user screen and `POST /api/users/first-register` are not used.
 */
export function allowsUserCreation(req: Pick<PayloadRequest, 'payloadAPI' | 'user'>): boolean {
  return req.payloadAPI === 'local' || Boolean(req.user)
}

export const guardPublicUserCreation: CollectionBeforeOperationHook = ({
  args,
  operation,
  req,
}) => {
  if (operation === 'create' && !allowsUserCreation(req)) throw new Forbidden(req.t)
  return args
}
