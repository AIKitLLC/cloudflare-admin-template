/** Firebase client identity never grants administrator permissions. */
import { decodeProtectedHeader, importJWK, importX509, jwtVerify, type JWTPayload } from 'jose'

export const FIREBASE_APP_CHECK_JWKS_ENDPOINT = 'https://firebaseappcheck.googleapis.com/v1/jwks'
export const FIREBASE_ID_CERTIFICATES_ENDPOINT =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
const MAX_TOKEN_BYTES = 16 * 1024,
  MAX_KEYS_BYTES = 128 * 1024,
  MAX_KEYS = 20
const MAX_CACHE_MS = 6 * 60 * 60 * 1000,
  UNKNOWN_KEY_COOLDOWN_MS = 30_000,
  FAILURE_BACKOFF_MS = 5000
const KEY_ID = /^[A-Za-z0-9_-]{1,128}$/

export interface FirebaseClientEnv {
  FIREBASE_CLIENT_ENABLED?: string
  FIREBASE_PROJECT_ID?: string
  FIREBASE_PROJECT_NUMBER?: string
  FIREBASE_APP_IDS?: string
}
export interface FirebaseClientConfig {
  readonly projectId: string
  readonly projectNumber: string
  readonly appIds: readonly string[]
}
export interface FirebaseClientIdentity {
  readonly uid: string
  readonly appId: string
  readonly projectId: string
}
export type FirebaseAuthReason =
  | 'firebase_client_disabled'
  | 'firebase_client_misconfigured'
  | 'firebase_credentials_missing'
  | 'firebase_credentials_invalid'
  | 'firebase_keys_unavailable'
export class FirebaseAuthError extends Error {
  constructor(
    readonly status: 401 | 503,
    readonly reason: FirebaseAuthReason,
  ) {
    super(reason)
    this.name = 'FirebaseAuthError'
  }
}
export interface FirebaseAuthDependencies {
  fetcher?: typeof fetch
  nowMs?: () => number
  timeoutMs?: number
}
export type FirebaseClientAuthenticator = (
  request: Request,
  env: FirebaseClientEnv,
) => Promise<FirebaseClientIdentity>

export function readFirebaseClientConfig(env: FirebaseClientEnv): FirebaseClientConfig | null {
  if (
    env.FIREBASE_CLIENT_ENABLED !== 'true' ||
    typeof env.FIREBASE_PROJECT_ID !== 'string' ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.FIREBASE_PROJECT_ID) ||
    typeof env.FIREBASE_PROJECT_NUMBER !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(env.FIREBASE_PROJECT_NUMBER) ||
    typeof env.FIREBASE_APP_IDS !== 'string' ||
    env.FIREBASE_APP_IDS.length > 4096
  )
    return null
  const appIds = env.FIREBASE_APP_IDS.split(',').map((value) => value.trim())
  if (
    !appIds.length ||
    appIds.length > 20 ||
    new Set(appIds).size !== appIds.length ||
    !appIds.every(
      (value) =>
        /^1:[1-9][0-9]{0,19}:(android|ios|web):[A-Za-z0-9_-]{1,128}$/.test(value) &&
        value.split(':')[1] === env.FIREBASE_PROJECT_NUMBER,
    )
  )
    return null
  return Object.freeze({
    projectId: env.FIREBASE_PROJECT_ID,
    projectNumber: env.FIREBASE_PROJECT_NUMBER,
    appIds: Object.freeze(appIds),
  })
}

function invalid(): never {
  throw new FirebaseAuthError(401, 'firebase_credentials_invalid')
}
function unavailable(): never {
  throw new FirebaseAuthError(503, 'firebase_keys_unavailable')
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable()
  return value as Record<string, unknown>
}
function tokenHeader(token: string, appCheck: boolean): string {
  if (
    token.length > MAX_TOKEN_BYTES ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  )
    invalid()
  try {
    const header = decodeProtectedHeader(token)
    if (
      header.alg !== 'RS256' ||
      (appCheck && header.typ !== 'JWT') ||
      typeof header.kid !== 'string' ||
      !KEY_ID.test(header.kid) ||
      ['jku', 'jwk', 'x5u', 'x5c', 'crit'].some((key) => key in header)
    )
      invalid()
    return header.kid
  } catch {
    invalid()
  }
}
function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  try {
    if (body) void body.cancel().catch(() => {})
  } catch {
    /* Cleanup cannot expose provider details. */
  }
}
async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (
    response.status !== 200 ||
    !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
    !response.body
  ) {
    cancelBody(response.body)
    unavailable()
  }
  const length = response.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_KEYS_BYTES)) {
    cancelBody(response.body)
    unavailable()
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0,
    onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new FirebaseAuthError(503, 'firebase_keys_unavailable'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), aborted])
      if (done) break
      size += value.byteLength
      if (size > MAX_KEYS_BYTES) unavailable()
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch {
    try {
      void reader.cancel().catch(() => {})
    } catch {
      /* Never await a stalled provider cleanup. */
    }
    return unavailable()
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      /* A pending read may still own the lock after timeout. */
    }
  }
}
function cacheLifetime(response: Response, appCheck: boolean): number {
  const control = response.headers.get('cache-control') ?? ''
  if (/(?:^|,)\s*(?:no-cache|no-store)\b/i.test(control)) return 0
  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i.exec(control)
  const seconds = match
    ? Math.min(Number(match[1]), MAX_CACHE_MS / 1000)
    : appCheck
      ? MAX_CACHE_MS / 1000
      : 0
  const age = response.headers.get('age')
  if (age !== null && !/^\d+$/.test(age)) return 0
  return Math.max(0, seconds - Number(age ?? 0)) * 1000
}
function assertRsaKey(key: CryptoKey): void {
  const algorithm = key.algorithm as RsaHashedKeyAlgorithm
  if (
    key.type !== 'public' ||
    algorithm.name !== 'RSASSA-PKCS1-v1_5' ||
    algorithm.hash?.name !== 'SHA-256' ||
    algorithm.modulusLength < 2048 ||
    algorithm.modulusLength > 8192
  )
    unavailable()
}
async function publicKeys(
  body: Record<string, unknown>,
  appCheck: boolean,
): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>()
  if (appCheck) {
    if (!Array.isArray(body.keys) || !body.keys.length || body.keys.length > MAX_KEYS) unavailable()
    for (const candidate of body.keys) {
      const jwk = record(candidate)
      if (
        typeof jwk.kid !== 'string' ||
        !KEY_ID.test(jwk.kid) ||
        keys.has(jwk.kid) ||
        jwk.kty !== 'RSA' ||
        (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
        (jwk.use !== undefined && jwk.use !== 'sig') ||
        typeof jwk.n !== 'string' ||
        !/^[A-Za-z0-9_-]{342,1366}$/.test(jwk.n) ||
        typeof jwk.e !== 'string' ||
        !/^[A-Za-z0-9_-]{1,16}$/.test(jwk.e) ||
        ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'jku', 'x5u'].some((value) => value in jwk) ||
        (jwk.key_ops !== undefined &&
          (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify'))
      )
        unavailable()
      const key = await importJWK(jwk, 'RS256')
      if (key instanceof Uint8Array) unavailable()
      assertRsaKey(key)
      keys.set(jwk.kid, key)
    }
  } else {
    const entries = Object.entries(body)
    if (!entries.length || entries.length > MAX_KEYS) unavailable()
    for (const [kid, certificate] of entries) {
      if (
        !KEY_ID.test(kid) ||
        typeof certificate !== 'string' ||
        certificate.length > 16 * 1024 ||
        !certificate.startsWith('-----BEGIN CERTIFICATE-----\n') ||
        !certificate.trimEnd().endsWith('-----END CERTIFICATE-----')
      )
        unavailable()
      const key = await importX509(certificate, 'RS256')
      assertRsaKey(key)
      keys.set(kid, key)
    }
  }
  return keys
}
interface KeyCache {
  keys: Map<string, CryptoKey>
  expiresAt: number
  lastAttemptAt: number
  failureUntil: number
  inFlight?: Promise<Map<string, CryptoKey>>
}
function keyProvider(
  appCheck: boolean,
  fetcher: typeof fetch,
  nowMs: () => number,
  timeoutMs: number,
) {
  const cache: KeyCache = {
    keys: new Map(),
    expiresAt: 0,
    lastAttemptAt: -Infinity,
    failureUntil: 0,
  }
  const endpoint = appCheck ? FIREBASE_APP_CHECK_JWKS_ENDPOINT : FIREBASE_ID_CERTIFICATES_ENDPOINT
  async function refresh(): Promise<Map<string, CryptoKey>> {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    cache.lastAttemptAt = nowMs()
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new FirebaseAuthError(503, 'firebase_keys_unavailable'))
      }, timeoutMs)
    })
    const load = async () => {
      const pending = fetcher(endpoint, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      })
      void pending.then(
        (late) => {
          if (controller.signal.aborted) cancelBody(late.body)
        },
        () => {},
      )
      const response = await pending
      const body = await boundedJson(response, controller.signal)
      const keys = await publicKeys(body, appCheck)
      if (controller.signal.aborted) unavailable()
      cache.keys = keys
      cache.expiresAt = nowMs() + cacheLifetime(response, appCheck)
      cache.failureUntil = 0
      return keys
    }
    try {
      return await Promise.race([load(), deadline])
    } catch {
      cache.failureUntil = nowMs() + FAILURE_BACKOFF_MS
      return unavailable()
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }
  return async (kid: string): Promise<CryptoKey> => {
    const now = nowMs()
    if (cache.expiresAt > now && cache.keys.has(kid)) return cache.keys.get(kid)!
    if (!cache.inFlight) {
      if (cache.failureUntil > now) unavailable()
      // An unknown kid cannot bypass the refresh cooldown with an uncacheable key response.
      // Known keys still revalidate after max-age/no-store requires it.
      if (
        cache.keys.size &&
        !cache.keys.has(kid) &&
        now - cache.lastAttemptAt < UNKNOWN_KEY_COOLDOWN_MS
      )
        invalid()
      cache.inFlight = refresh().finally(() => {
        cache.inFlight = undefined
      })
    }
    const key = (await cache.inFlight).get(kid)
    if (!key) invalid()
    return key
  }
}
function pastTimestamp(value: unknown, now: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= now
}
function validateTimes(claims: JWTPayload, now: number, idToken: boolean): void {
  if (
    !pastTimestamp(claims.iat, now) ||
    typeof claims.exp !== 'number' ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    (idToken && (!pastTimestamp(claims.auth_time, now) || claims.auth_time > claims.iat))
  )
    invalid()
}
function currentTime(nowMs: () => number): number {
  const now = nowMs()
  if (!Number.isSafeInteger(now) || now < 0)
    throw new FirebaseAuthError(503, 'firebase_client_misconfigured')
  return now
}
async function verifiedClaims(
  token: string,
  kid: string,
  getKey: (kid: string) => Promise<CryptoKey>,
  issuer: string,
  audience: string,
  nowMs: () => number,
  appCheck: boolean,
): Promise<JWTPayload> {
  const key = await getKey(kid)
  const now = currentTime(nowMs)
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['RS256'],
      issuer,
      audience,
      clockTolerance: 0,
      currentDate: new Date(now),
      requiredClaims: appCheck
        ? ['iss', 'aud', 'sub', 'iat', 'exp']
        : ['iss', 'aud', 'sub', 'iat', 'exp', 'auth_time'],
    })
    validateTimes(payload, Math.floor(now / 1000), !appCheck)
    return payload
  } catch {
    invalid()
  }
}

/** Dependencies are bound once per Worker isolate, so key caches survive requests without retaining tokens. */
export function createFirebaseClientAuthenticator(
  dependencies: FirebaseAuthDependencies = {},
): FirebaseClientAuthenticator {
  const fetcher = dependencies.fetcher ?? fetch,
    nowMs = dependencies.nowMs ?? Date.now
  const timeoutMs = Math.min(5000, Math.max(1, dependencies.timeoutMs ?? 5000))
  const appCheckKeys = keyProvider(true, fetcher, nowMs, timeoutMs),
    idKeys = keyProvider(false, fetcher, nowMs, timeoutMs)
  return async (request, env) => {
    if (env.FIREBASE_CLIENT_ENABLED !== 'true')
      throw new FirebaseAuthError(503, 'firebase_client_disabled')
    const config = readFirebaseClientConfig(env)
    if (!config) throw new FirebaseAuthError(503, 'firebase_client_misconfigured')
    const appCheckToken = request.headers.get('X-Firebase-AppCheck'),
      authorization = request.headers.get('Authorization')
    if (!appCheckToken || !authorization)
      throw new FirebaseAuthError(401, 'firebase_credentials_missing')
    const bearer = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization)
    if (!bearer) invalid()
    const idToken = bearer[1],
      appCheckKid = tokenHeader(appCheckToken, true),
      idKid = tokenHeader(idToken, false)
    currentTime(nowMs)
    const appCheck = await verifiedClaims(
      appCheckToken,
      appCheckKid,
      appCheckKeys,
      `https://firebaseappcheck.googleapis.com/${config.projectNumber}`,
      `projects/${config.projectNumber}`,
      nowMs,
      true,
    )
    if (typeof appCheck.sub !== 'string' || !config.appIds.includes(appCheck.sub)) invalid()
    const identity = await verifiedClaims(
      idToken,
      idKid,
      idKeys,
      `https://securetoken.google.com/${config.projectId}`,
      config.projectId,
      nowMs,
      false,
    )
    if (
      identity.aud !== config.projectId ||
      typeof identity.sub !== 'string' ||
      identity.sub.length < 1 ||
      identity.sub.length > 128 ||
      identity.sub.trim() !== identity.sub ||
      [...identity.sub].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      !identity.firebase ||
      typeof identity.firebase !== 'object' ||
      Array.isArray(identity.firebase) ||
      (identity.firebase as Record<string, unknown>).sign_in_provider !== 'anonymous'
    )
      invalid()
    const now = Math.floor(currentTime(nowMs) / 1000)
    validateTimes(appCheck, now, false)
    validateTimes(identity, now, true)
    return Object.freeze({ uid: identity.sub, appId: appCheck.sub, projectId: config.projectId })
  }
}
export const authenticateFirebaseClient = createFirebaseClientAuthenticator()
