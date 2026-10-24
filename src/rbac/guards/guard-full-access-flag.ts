import type { PayloadRequest } from 'payload'
import { APIError } from 'payload'

import { userGrantsFullAccess } from '../../access'
import { FULL_ACCESS_FLAG_ERROR } from './privilege-errors'
import { skipsPrivilegeChecks } from '../../access'

export async function assertCanChangeFullAccessFlag(args: {
  context: unknown
  data: { grantsFullAccess?: boolean | null }
  operation: string
  originalDoc?: { grantsFullAccess?: boolean | null } | null
  req: PayloadRequest
}): Promise<void> {
  if (skipsPrivilegeChecks(args.context) || !args.req.user) {
    return
  }
  const next = args.data.grantsFullAccess
  if (next === undefined) {
    return
  }
  const previous = args.operation === 'create' ? false : Boolean(args.originalDoc?.grantsFullAccess)
  if (Boolean(next) === previous) {
    return
  }
  if (await userGrantsFullAccess(args.req)) {
    return
  }
  throw new APIError(FULL_ACCESS_FLAG_ERROR, 403)
}
