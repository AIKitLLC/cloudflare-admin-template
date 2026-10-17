import { createHash, timingSafeEqual } from 'node:crypto'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { Forbidden, type CollectionBeforeOperationHook, type PayloadRequest } from 'payload'

/** Request header that carries the first-admin setup token. */
export const ADMIN_SETUP_TOKEN_HEADER = 'x-admin-setup-token'
/** Worker secret name. Set it with `wrangler secret put ADMIN_SETUP_TOKEN`; never a var. */
export const ADMIN_SETUP_TOKEN_NAME = 'ADMIN_SETUP_TOKEN'
export const ADMIN_SETUP_TOKEN_MIN_LENGTH = 32

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Compares fixed-length digests so the comparison time does not depend on the input. */
export function setupTokenMatches(
  provided: string | null | undefined,
  expected: string | undefined,
) {
  if (!expected || expected.length < ADMIN_SETUP_TOKEN_MIN_LENGTH) return false
  if (typeof provided !== 'string' || provided.length === 0) return false
  return timingSafeEqual(digest(provided), digest(expected))
}

export type PublicUserCreationDecision = 'allow' | 'deny'

/**
 * First-admin bootstrap policy for `users` creation.
 *
 * - Local API calls (CLI scripts, seeds, tests) and signed-in requests are left to the
 *   normal access rules.
 * - A request without a user may only create the first user, and only with a setup token
 *   that matches the ADMIN_SETUP_TOKEN Worker secret. Once any user exists it is denied.
 */
export function decidePublicUserCreation(args: {
  payloadAPI: PayloadRequest['payloadAPI']
  hasUser: boolean
  existingUsers: number
  providedToken: string | null | undefined
  expectedToken: string | undefined
}): PublicUserCreationDecision {
  if (args.payloadAPI === 'local' || args.hasUser) return 'allow'
  if (args.existingUsers > 0) return 'deny'
  return setupTokenMatches(args.providedToken, args.expectedToken) ? 'allow' : 'deny'
}

async function readSetupToken(): Promise<string | undefined> {
  const fromProcess = process.env[ADMIN_SETUP_TOKEN_NAME]
  if (fromProcess) return fromProcess
  try {
    const context = await getCloudflareContext({ async: true })
    const value = (context.env as unknown as Record<string, unknown>)[ADMIN_SETUP_TOKEN_NAME]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

export const guardPublicUserCreation: CollectionBeforeOperationHook = async ({
  args,
  operation,
  req,
}) => {
  if (operation !== 'create') return args
  if (req.payloadAPI === 'local' || req.user) return args
  const { totalDocs } = await req.payload.count({
    collection: 'users',
    overrideAccess: true,
    req,
  })
  const decision = decidePublicUserCreation({
    payloadAPI: req.payloadAPI,
    hasUser: Boolean(req.user),
    existingUsers: totalDocs,
    providedToken: req.headers?.get(ADMIN_SETUP_TOKEN_HEADER),
    expectedToken: totalDocs === 0 ? await readSetupToken() : undefined,
  })
  if (decision === 'deny') throw new Forbidden(req.t)
  return args
}
