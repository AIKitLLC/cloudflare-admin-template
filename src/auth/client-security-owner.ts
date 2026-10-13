import {
  APIError,
  type CollectionAfterOperationHook,
  type CollectionBeforeChangeHook,
  type CollectionBeforeDeleteHook,
  type CollectionBeforeOperationHook,
  type Payload,
  type PayloadRequest,
  type Where,
} from 'payload'

export const CLIENT_SECURITY_ROLES = ['owner', 'admin', 'editor'] as const
export type ClientSecurityRole = (typeof CLIENT_SECURITY_ROLES)[number]
interface UsersIdentity {
  id: number | string
  collection: 'users'
  role?: unknown
}
// Private request capabilities are created only by Payload's actual forgot-password operation.
// They cannot be supplied through JSON, req.context, headers, or Local API access overrides.
const pendingRecovery = new WeakSet<PayloadRequest>()
const recoveryWrites = new WeakMap<
  PayloadRequest,
  { id: number | string; token: string; expiration: string }
>()

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function validId(value: unknown): value is number | string {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value)
  )
}

function usersIdentity(value: unknown): value is UsersIdentity {
  const user = object(value)
  return user?.collection === 'users' && validId(user.id)
}

/** Accepts only a Payload Users identity, never a Firebase principal or arbitrary role string. */
export function isClientSecurityOwner(user: unknown): user is UsersIdentity & { role: 'owner' } {
  return usersIdentity(user) && user.role === 'owner'
}

/** Recheck storage after payload.auth: JWT claims and stale request roles do not grant authority. */
export async function isStoredClientSecurityOwner(
  payload: Payload,
  user: unknown,
): Promise<boolean> {
  if (!usersIdentity(user)) return false
  try {
    const stored = await payload.findByID({
      collection: 'users',
      id: user.id,
      depth: 0,
      overrideAccess: true,
    })
    return object(stored)?.role === 'owner' && String(stored.id) === String(user.id)
  } catch {
    return false
  }
}

function denied(): never {
  throw new APIError('Only a client security owner may perform this operation.', 403)
}

function lastOwner(): never {
  throw new APIError('The final client security owner cannot be removed or demoted.', 409)
}

async function ownerCount(req: PayloadRequest, where?: Where): Promise<number> {
  const owners: Where = { role: { equals: 'owner' } }
  const result = await req.payload.count({
    collection: 'users',
    overrideAccess: true,
    req,
    where: where ? { and: [owners, where] } : owners,
  })
  return result.totalDocs
}

function targetWhere(args: unknown): Where | undefined {
  const input = object(args)
  if (input && validId(input.id)) return { id: { equals: input.id } }
  return object(input?.where) as Where | undefined
}

async function unchangedOrdinaryRole(
  req: PayloadRequest,
  input: Record<string, unknown> | undefined,
  role: unknown,
): Promise<boolean> {
  if (!validId(input?.id) || (role !== 'admin' && role !== 'editor')) return false
  try {
    const target = await req.payload.findByID({
      collection: 'users',
      id: input.id,
      depth: 0,
      overrideAccess: true,
      req,
    })
    return String(target.id) === String(input.id) && target.role === role
  } catch {
    return false
  }
}

/** Runs before access overrides and field stripping, including the default Local API override. */
export const guardClientSecurityOwnerOperation: CollectionBeforeOperationHook = async ({
  args,
  operation,
  req,
}) => {
  if (operation === 'forgotPassword') {
    pendingRecovery.add(req)
    return
  }
  if (operation !== 'create' && operation !== 'update' && operation !== 'delete') return
  const input = object(args)
  const data = object(input?.data)
  const submittedRole = !!data && Object.hasOwn(data, 'role')
  if (
    operation === 'update' &&
    pendingRecovery.has(req) &&
    validId(input?.id) &&
    data &&
    Object.keys(data).length === 2 &&
    typeof data.resetPasswordToken === 'string' &&
    /^[a-f0-9]{40}$/.test(data.resetPasswordToken) &&
    typeof data.resetPasswordExpiration === 'string' &&
    Number.isFinite(Date.parse(data.resetPasswordExpiration))
  ) {
    pendingRecovery.delete(req)
    recoveryWrites.set(req, {
      id: input.id,
      token: data.resetPasswordToken,
      expiration: data.resetPasswordExpiration,
    })
    return
  }
  if (submittedRole) {
    if (!CLIENT_SECURITY_ROLES.includes(data.role as ClientSecurityRole))
      throw new APIError('Invalid user role.', 400)
    // Explicit default admin on creation has the same authority as omitting the field.
    // Collection create access still applies; owner/editor assignment requires an owner.
    if (
      !(operation === 'create' && data.role === 'admin') &&
      !(await isStoredClientSecurityOwner(req.payload, req.user)) &&
      // Payload's disabled role field is still serialized by ordinary profile forms.
      // Accept its exact stored value only for one nonowner target; role changes stay protected.
      !(operation === 'update' && (await unchangedOrdinaryRole(req, input, data.role)))
    )
      denied()
  }
  if (operation === 'create') return
  const where = targetWhere(args)
  if (!where) return // Payload validates missing IDs/where without changing any record.
  const selectedOwners = await ownerCount(req, where)
  if (!selectedOwners) return
  // Protect owner credentials and sessions as well as role; CMS access stays otherwise unchanged.
  if (!(await isStoredClientSecurityOwner(req.payload, req.user))) denied()
  if (operation === 'delete' || (submittedRole && data.role !== 'owner')) {
    if (selectedOwners >= (await ownerCount(req))) lastOwner()
  }
}

/** Recheck the actual document immediately before normal writes, including bulk updates. */
export const guardClientSecurityOwnerChange: CollectionBeforeChangeHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (operation !== 'update' || object(originalDoc)?.role !== 'owner') return data
  const recovery = recoveryWrites.get(req)
  if (recovery) {
    recoveryWrites.delete(req)
    if (
      String(recovery.id) === String(originalDoc.id) &&
      data.resetPasswordToken === recovery.token &&
      data.resetPasswordExpiration === recovery.expiration &&
      (!Object.hasOwn(data, 'role') || data.role === 'owner')
    )
      return data
    denied()
  }
  if (!(await isStoredClientSecurityOwner(req.payload, req.user))) denied()
  if (Object.hasOwn(data, 'role') && data.role !== 'owner' && (await ownerCount(req)) <= 1)
    lastOwner()
  return data
}

export const guardClientSecurityOwnerDelete: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const user = await req.payload.findByID({
    collection: 'users',
    id,
    overrideAccess: true,
    depth: 0,
    req,
  })
  if (object(user)?.role !== 'owner') return
  if (!(await isStoredClientSecurityOwner(req.payload, req.user))) denied()
  if ((await ownerCount(req)) <= 1) lastOwner()
}

export const clearClientSecurityRecoveryOperation: CollectionAfterOperationHook = ({
  operation,
  req,
  result,
}) => {
  if (operation === 'forgotPassword' || operation === 'update' || operation === 'updateByID') {
    pendingRecovery.delete(req)
    recoveryWrites.delete(req)
  }
  return result
}
