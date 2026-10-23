import type { Payload } from 'payload'

import { isStoredClientSecurityOwner } from '../auth'
import {
  clientSecurityReadiness,
  ClientSecurityValidationError,
  type ClientSecurityConfiguration,
} from './schema'
import {
  ClientSecurityStoreError,
  createClientSecurityStore,
  type ClientSecurityDatabase,
} from './store'

interface Services {
  payload: Payload
  db: ClientSecurityDatabase
}
interface Options {
  getServices: () => Promise<Services>
  authenticateOwner?: (request: Request, payload: Payload) => Promise<string | null>
}

const response = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie' },
  })
function invalid(): never {
  throw new ClientSecurityStoreError(400, 'client_security_invalid_operation')
}
const conflict = () => {
  throw new ClientSecurityStoreError(409, 'client_security_revision_conflict')
}

async function owner(request: Request, payload: Payload): Promise<string | null> {
  const { user } = await payload.auth({ headers: request.headers })
  return (await isStoredClientSecurityOwner(payload, user)) ? `users:${user!.id}` : null
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    invalid()
  const reader = request.body?.getReader()
  if (!reader) invalid()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 16_384) {
      await reader.cancel()
      invalid()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!body || typeof body !== 'object' || Array.isArray(body)) invalid()
    return body
  } catch {
    return invalid()
  }
}

function keys(body: Record<string, unknown>, expected: string[]): void {
  if (
    Object.keys(body).length !== expected.length ||
    Object.keys(body).some((key) => !expected.includes(key))
  )
    invalid()
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid()
  return value as number
}

function changes(before: ClientSecurityConfiguration, after: ClientSecurityConfiguration) {
  const fields = [
    ['firebase.enabled', before.firebase.enabled, after.firebase.enabled],
    ['firebase.projectId', before.firebase.projectId, after.firebase.projectId],
    ['firebase.projectNumber', before.firebase.projectNumber, after.firebase.projectNumber],
    ['firebase.appIds', before.firebase.appIds, after.firebase.appIds],
    ['limits.windowSeconds', before.limits.windowSeconds, after.limits.windowSeconds],
    ['limits.uid', before.limits.uid, after.limits.uid],
    ['limits.ip', before.limits.ip, after.limits.ip],
    ['limits.global', before.limits.global, after.limits.global],
  ] as const
  return fields
    .filter(([, oldValue, newValue]) => JSON.stringify(oldValue) !== JSON.stringify(newValue))
    .map(([field, oldValue, newValue]) => ({ field, before: oldValue, after: newValue }))
}

/** Separate owner authority and CSRF boundary from the existing generic CMS REST routes. */
export function createClientSecurityAdminRoute({
  getServices,
  authenticateOwner = owner,
}: Options) {
  async function handle(request: Request, write: boolean): Promise<Response> {
    try {
      const { payload, db } = await getServices()
      const actor = await authenticateOwner(request, payload)
      if (!actor) return response({ error: 'client_security_owner_required' }, 403)
      const store = createClientSecurityStore(db)
      if (!write) {
        const snapshot = await store.read()
        const history = (await store.history()).map(
          ({ revision, digest, actor, operation, createdAt }) => ({
            revision,
            digest,
            actor,
            operation,
            createdAt,
          }),
        )
        return response({
          snapshot,
          readiness: clientSecurityReadiness(snapshot.configuration),
          history,
        })
      }
      // Browser requests must be same-origin JSON with a custom header. The template's
      // general Payload csrf setting is not an allowlist, so it cannot secure these writes.
      const origin = request.headers.get('Origin')
      if (
        request.headers.get('X-Client-Security-Action') !== 'manage' ||
        !origin ||
        origin !== new URL(request.url).origin ||
        (request.headers.has('Sec-Fetch-Site') &&
          request.headers.get('Sec-Fetch-Site') !== 'same-origin')
      ) {
        return response({ error: 'client_security_origin_required' }, 403)
      }
      const body = await readBody(request)
      const rollback = body.action === 'previewRollback' || body.action === 'rollback'
      const preview = body.action === 'preview' || body.action === 'previewRollback'
      if (!preview && body.action !== 'save' && body.action !== 'rollback') invalid()
      keys(body, [
        'action',
        'expectedRevision',
        rollback ? 'rollbackRevision' : 'configuration',
        ...(preview ? [] : ['reviewedDigest']),
      ])
      const expectedRevision = revision(body.expectedRevision)
      const current = await store.read()
      if (current.revision !== expectedRevision) conflict()
      const rollbackRevision = rollback ? revision(body.rollbackRevision) : undefined
      const configuration = rollback
        ? (await store.readVersion(rollbackRevision!)).configuration
        : body.configuration
      if (preview) {
        const result = await store.preview(configuration)
        if (result.currentRevision !== expectedRevision) conflict()
        return response({
          ...result,
          changes: changes(current.configuration, result.configuration),
        })
      }
      if (typeof body.reviewedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(body.reviewedDigest))
        invalid()
      // Recheck after parsing/preview lookup; a stale session role never grants a write.
      if ((await authenticateOwner(request, payload)) !== actor)
        return response({ error: 'client_security_owner_required' }, 403)
      const snapshot = await store.save({
        expectedRevision,
        configuration,
        reviewedDigest: body.reviewedDigest as string,
        actor,
        operation: rollback ? 'rollback' : 'save',
        ...(rollback ? { rollbackRevision } : {}),
      })
      return response({ snapshot, readiness: clientSecurityReadiness(snapshot.configuration) })
    } catch (error) {
      const known =
        error instanceof ClientSecurityStoreError || error instanceof ClientSecurityValidationError
      return response(
        { error: known ? error.reason : 'client_security_unavailable' },
        known ? error.status : 503,
      )
    }
  }
  return {
    GET: (request: Request) => handle(request, false),
    POST: (request: Request) => handle(request, true),
  }
}
