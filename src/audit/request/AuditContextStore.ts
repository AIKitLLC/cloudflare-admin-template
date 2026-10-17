import type { PayloadRequest } from 'payload'

import { AUDIT_CONTEXT_KEY } from '../constants'
import { isPlainObject } from '../diff/isPlainObject'

export type CapturedAuditContext = {
  /**
   * Names of sensitive fields present on the incoming write.
   * Values are intentionally not stored. Payload removes `password` before afterChange.
   */
  submittedSecretPaths: string[]
}

type AuditContextStore = {
  byData: WeakMap<object, CapturedAuditContext>
  byDocument: Map<string, CapturedAuditContext>
}

/**
 * Pairs a beforeChange capture with the matching afterChange.
 * Updates and deletes are keyed by collection plus document id, replacing any
 * earlier capture for that id so a failed write cannot be reused.
 * Creates have no id yet, so they are keyed by the `data` object Payload passes
 * through that operation. There is no stack: a missing key is a miss, not the
 * next document's snapshot.
 */
export function rememberAuditCapture(
  req: PayloadRequest,
  args: {
    collectionSlug: string
    data: unknown
    documentId: string | null
    captured: CapturedAuditContext
  },
): void {
  const store = ensureStore(req)
  if (isPlainObject(args.data)) store.byData.set(args.data, args.captured)
  if (args.documentId) store.byDocument.set(documentKey(args.collectionSlug, args.documentId), args.captured)
}

export function takeAuditCapture(
  req: PayloadRequest,
  args: {
    collectionSlug: string
    data: unknown
    documentId: string | null
  },
): CapturedAuditContext | undefined {
  const store = readStore(req)
  if (!store) return undefined

  let found: CapturedAuditContext | undefined
  if (isPlainObject(args.data) && store.byData.has(args.data)) {
    found = store.byData.get(args.data)
    store.byData.delete(args.data)
  }
  if (args.documentId) {
    const key = documentKey(args.collectionSlug, args.documentId)
    const keyed = store.byDocument.get(key)
    if (store.byDocument.has(key)) store.byDocument.delete(key)
    found = found ?? keyed
  }
  return found
}

export function documentIdOf(value: unknown): string | null {
  const record = isPlainObject(value) ? value : null
  const id = record?.id
  if (id == null || id === '') return null
  return String(id)
}

function documentKey(collectionSlug: string, documentId: string): string {
  return `${collectionSlug}:${documentId}`
}

function ensureStore(req: PayloadRequest): AuditContextStore {
  const existing = readStore(req)
  if (existing) return existing
  const created: AuditContextStore = { byData: new WeakMap(), byDocument: new Map() }
  req.context[AUDIT_CONTEXT_KEY] = created
  return created
}

function readStore(req: PayloadRequest): AuditContextStore | undefined {
  const existing = req.context[AUDIT_CONTEXT_KEY]
  if (!isStore(existing)) return undefined
  return existing
}

function isStore(value: unknown): value is AuditContextStore {
  return (
    isPlainObject(value) &&
    value.byData instanceof WeakMap &&
    value.byDocument instanceof Map
  )
}
