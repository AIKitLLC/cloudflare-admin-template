import type {
  CollectionBeforeChangeHook,
  CollectionBeforeOperationHook,
  PayloadRequest,
} from 'payload'

import { userGrantsFullAccess } from '../../access'
import { skipsPrivilegeChecks } from '../../access'
import { USER_SCOPE_FIELDS } from '../constants'
import { applyScopeAssignmentPolicy } from './apply-scope-assignment-policy'
import { collapseAndCapScopeFields } from './normalize-scope-fields'

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
  const id = 'id' in args ? (args.id as number | string | undefined) : undefined
  if (operation === 'update' && (id === undefined || id === null)) {
    return args
  }
  const original =
    operation === 'update' ? await loadOriginalUser(req, id as number | string) : undefined
  const next = await prepareScopeData({
    data,
    original,
    req,
    targetId: id,
  })
  if (!next) {
    return args
  }
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
  if (operation === 'update' && (originalDoc?.id === undefined || originalDoc?.id === null)) {
    return data
  }
  const next = await prepareScopeData({
    data: record,
    original: originalDoc as Record<string, unknown> | undefined,
    req,
    targetId: operation === 'create' ? undefined : (originalDoc?.id as number | string),
  })
  return next ?? data
}

async function prepareScopeData(args: {
  data: Record<string, unknown>
  original?: Record<string, unknown>
  req: PayloadRequest
  targetId?: number | string
}): Promise<Record<string, unknown> | undefined> {
  if (skipsPrivilegeChecks(args.req.context) || !args.req.user) {
    return undefined
  }
  const relevant =
    args.data.roles !== undefined ||
    USER_SCOPE_FIELDS.some((field) => args.data[field] !== undefined)
  if (!relevant) {
    return undefined
  }
  if (await userGrantsFullAccess(args.req)) {
    const next = { ...args.data }
    await collapseAndCapScopeFields(args.req, next, args.original)
    return next
  }
  return applyScopeAssignmentPolicy(args)
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
