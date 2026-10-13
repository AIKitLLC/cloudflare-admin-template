import {
  authenticateFirebaseClient,
  FirebaseAuthError,
  type FirebaseClientAuthenticator,
  type FirebaseClientEnv,
  type FirebaseClientIdentity,
} from './firebase-client'

export type FirebaseClientHandler = (
  request: Request,
  principal: FirebaseClientIdentity,
) => Response | Promise<Response>

interface FirebaseClientRouteOptions {
  getEnv: () => FirebaseClientEnv | Promise<FirebaseClientEnv>
  authenticate?: FirebaseClientAuthenticator
}

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'private, no-store')
  headers.append('Vary', 'Authorization, X-Firebase-AppCheck')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Keeps Firebase client identity separate from Payload's user/session authentication. */
export function createFirebaseClientRoute(
  handler: FirebaseClientHandler,
  { getEnv, authenticate = authenticateFirebaseClient }: FirebaseClientRouteOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let principal: FirebaseClientIdentity
    try {
      principal = await authenticate(request, await getEnv())
    } catch (error) {
      const status = error instanceof FirebaseAuthError ? error.status : 503
      const reason = error instanceof FirebaseAuthError ? error.reason : 'firebase_auth_unavailable'
      return privateResponse(
        Response.json(
          { error: reason },
          {
            status,
            headers: status === 401 ? { 'WWW-Authenticate': 'Bearer' } : undefined,
          },
        ),
      )
    }
    // Application work starts only after both signatures and their claims are verified.
    return privateResponse(await handler(request, principal))
  }
}

export interface FirebaseOwnedRecord {
  firebaseProjectId: string
  firebaseUid: string
}

export function firebaseClientOwnsRecord(
  principal: FirebaseClientIdentity,
  record: FirebaseOwnedRecord,
): boolean {
  return record.firebaseProjectId === principal.projectId && record.firebaseUid === principal.uid
}

/** A collision-free account key for an application's persistent, atomic quota counter. */
export function firebaseClientQuotaKey(principal: FirebaseClientIdentity): string {
  return JSON.stringify([principal.projectId, principal.uid])
}
