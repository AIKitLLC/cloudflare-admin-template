import type {
  CollectionBeforeChangeHook,
  CollectionBeforeOperationHook,
  PayloadRequest,
} from 'payload'

import { userGrantsFullAccess } from '../../access/resolve/load-user-grants'
import { skipsPrivilegeChecks } from '../../rbac/guards/privilege-context'
import { USER_SCOPE_FIELDS } from '../constants'
import { applyScopeAssignmentPolicy } from './apply-scope-assignment-policy'

export const guardScopeAssignmentOperation: CollectionBeforeOperationHook = async ({
  args,
  operation,
  req,
}) => {
  if (operation !== 'create' && operation !== 'update') {
    return args
  }
  if (!args || typeof args !== 'object' || !('data' in args) || !args.data) {
    return args
  }
  const data = args.data as Record<string, unknown>
  if (!(await shouldEnforce(req, data))) {
    return args
  }
  const id = 'id' in args ? (args.id as number | string | undefined) : undefined
  if (operation === 'update' && (id === undefined || id === null)) {
    return args
  }
  const original =
    operation === 'update' ? await loadOriginalUser(req, id as number | string) : undefined
  const next = await applyScopeAssignmentPolicy({
    data,
    original,
    req,
    targetId: id,
  })
  return {
    ...args,
    data: next,
  }
}

export const guardScopeAssignment: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  operation,
  req,
}) => {
  if (!data) {
    return data
  }
  const record = data as Record<string, unknown>
  if (!(await shouldEnforce(req, record))) {
    return data
  }
  if (operation === 'update' && (originalDoc?.id === undefined || originalDoc?.id === null)) {
    return data
  }
  return applyScopeAssignmentPolicy({
    data: record,
    original: originalDoc as Record<string, unknown> | undefined,
    req,
    targetId: operation === 'create' ? undefined : (originalDoc?.id as number | string),
  })
}

async function shouldEnforce(req: PayloadRequest, data: Record<string, unknown>): Promise<boolean> {
  if (skipsPrivilegeChecks(req.context) || !req.user) {
    return false
  }
  const relevant =
    data.roles !== undefined || USER_SCOPE_FIELDS.some((field) => data[field] !== undefined)
  if (!relevant) {
    return false
  }
  return !(await userGrantsFullAccess(req))
}

async function loadOriginalUser(
  req: PayloadRequest,
  id: number | string,
): Promise<Record<string, unknown> | undefined> {
  const user = await req.payload.findByID({
    collection: 'users',
    id,
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })
  return (user as unknown as Record<string, unknown> | null) ?? undefined
}
