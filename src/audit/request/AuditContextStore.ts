import type { PayloadRequest } from 'payload'

import { AUDIT_CONTEXT_KEY } from '../constants'
import type { RequestAuditMetadata } from '../types'
import { isPlainObject } from '../diff/isPlainObject'

export type CapturedAuditContext = {
  /** Database document from beforeChange. Null on create. */
  originalDoc: Record<string, unknown> | null
  metadata: RequestAuditMetadata
  /**
   * Names of sensitive fields present on the incoming write.
   * Values are intentionally not stored. Payload removes `password` before afterChange.
   */
  submittedSecretPaths: string[]
}

type AuditContextStore = {
  stacks: Record<string, CapturedAuditContext[]>
}

/**
 * Stack per collection so nested writes of the same slug pop in LIFO order.
 * The snapshot can contain secrets (auth hashes). It lives only on the request
 * and is removed when the matching after-hook runs. The writer never persists it.
 */
export function pushAuditContext(
  req: PayloadRequest,
  collectionSlug: string,
  captured: CapturedAuditContext,
): void {
  const store = ensureStore(req)
  const stack = store.stacks[collectionSlug] ?? []
  stack.push(captured)
  store.stacks[collectionSlug] = stack
}

export function popAuditContext(
  req: PayloadRequest,
  collectionSlug: string,
): CapturedAuditContext | undefined {
  const stack = ensureStore(req).stacks[collectionSlug]
  if (!stack?.length) return undefined
  return stack.pop()
}

export function cloneRecord(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function ensureStore(req: PayloadRequest): AuditContextStore {
  const existing = req.context[AUDIT_CONTEXT_KEY]
  if (isStore(existing)) return existing
  const created: AuditContextStore = { stacks: {} }
  req.context[AUDIT_CONTEXT_KEY] = created
  return created
}

function isStore(value: unknown): value is AuditContextStore {
  return isPlainObject(value) && isPlainObject(value.stacks)
}
