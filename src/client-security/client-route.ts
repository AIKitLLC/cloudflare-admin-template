import {
  authenticateFirebaseClient,
  FirebaseAuthError,
  type FirebaseClientAuthenticator,
  type FirebaseClientIdentity,
} from '../auth/firebase'
import type { FirebaseClientHandler } from '../auth/firebase'
import {
  canonicalClientSecurityIp,
  ClientSecurityRateLimitError,
  createClientSecurityRateLimiter,
} from './rate-limits'
import {
  createClientSecurityStore,
  ClientSecurityStoreError,
  type ClientSecurityDatabase,
} from './store'

interface Options {
  getDatabase: () => ClientSecurityDatabase | Promise<ClientSecurityDatabase>
  getTrustedIp: (request: Request) => string | Promise<string>
  authenticate?: FirebaseClientAuthenticator
}

const privateResponse = (response: Response) => {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'private, no-store')
  headers.append('Vary', 'Authorization, X-Firebase-AppCheck')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** One adapter automatically authenticates and atomically admits all protected client work. */
export function createManagedFirebaseClientRoute(
  handler: FirebaseClientHandler,
  { getDatabase, getTrustedIp, authenticate = authenticateFirebaseClient }: Options,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let principal: FirebaseClientIdentity
    try {
      const db = await getDatabase()
      const snapshot = await createClientSecurityStore(db).read()
      const firebase = snapshot.configuration.firebase
      principal = await authenticate(request, {
        FIREBASE_CLIENT_ENABLED: String(firebase.enabled),
        FIREBASE_PROJECT_ID: firebase.projectId,
        FIREBASE_PROJECT_NUMBER: firebase.projectNumber,
        FIREBASE_APP_IDS: firebase.appIds.join(','),
      })
      const ip = canonicalClientSecurityIp(await getTrustedIp(request))
      await createClientSecurityRateLimiter(db).admit({ snapshot, principal, ip })
    } catch (error) {
      const known =
        error instanceof FirebaseAuthError ||
        error instanceof ClientSecurityStoreError ||
        error instanceof ClientSecurityRateLimitError
      const status = known ? error.status : 503
      const headers: Record<string, string> = {}
      if (status === 401) headers['WWW-Authenticate'] = 'Bearer'
      if (error instanceof ClientSecurityRateLimitError && error.retryAfter)
        headers['Retry-After'] = String(error.retryAfter)
      return privateResponse(
        Response.json(
          { error: known ? error.reason : 'client_security_unavailable' },
          { status, headers },
        ),
      )
    }
    return privateResponse(await handler(request, principal))
  }
}

/** Only use after obtaining a genuine Cloudflare incoming-request context. */
export function cloudflareClientIp(request: Request, cf: unknown): string {
  if (!cf || typeof cf !== 'object' || !(cf as Record<string, unknown>).colo) {
    throw new ClientSecurityRateLimitError(503, 'client_security_unavailable')
  }
  return canonicalClientSecurityIp(request.headers.get('CF-Connecting-IP'))
}
