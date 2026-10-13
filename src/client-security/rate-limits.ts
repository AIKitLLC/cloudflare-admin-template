import type { FirebaseClientIdentity } from '../auth/firebase-client'
import {
  canonicalClientSecurityConfiguration,
  digestClientSecurityConfiguration,
  validateClientSecurityConfiguration,
} from './schema'
import type { ClientSecurityDatabase, ClientSecuritySnapshot } from './store'

export type ClientSecurityRateLimitReason =
  'client_security_rate_limited' | 'client_security_unavailable'
export class ClientSecurityRateLimitError extends Error {
  readonly code: ClientSecurityRateLimitReason
  constructor(
    readonly status: 429 | 503,
    readonly reason: ClientSecurityRateLimitReason,
    readonly retryAfter?: number,
  ) {
    super(reason)
    this.name = 'ClientSecurityRateLimitError'
    this.code = reason
  }
}
export interface ClientSecurityAdmission {
  snapshot: ClientSecuritySnapshot
  principal: FirebaseClientIdentity
  /** Supplied by the trusted Worker request adapter, never a body/query parameter. */
  ip: string
}
export interface ClientSecurityRateLimitDependencies {
  nowMs?: () => number
}
export interface ClientSecurityAdmissionResult {
  readonly allowed: true
  readonly remaining: Readonly<Record<'uid' | 'ip' | 'global', number>>
  /** Unix seconds; each bucket keeps its existing deadline until expiry. */
  readonly resetAt: Readonly<Record<'uid' | 'ip' | 'global', number>>
}

function unavailable(): never {
  throw new ClientSecurityRateLimitError(503, 'client_security_unavailable')
}
async function hash(value: unknown): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function canonicalClientSecurityIp(ip: unknown): string {
  if (typeof ip !== 'string' || ip.length > 64) unavailable()
  if (/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(ip)) {
    if (ip.split('.').some((part) => Number(part) > 255)) unavailable()
    return ip
  }
  if (!ip.includes(':') || !/^[0-9A-Fa-f:.]{2,64}$/.test(ip)) unavailable()
  try {
    const hostname = new URL(`http://[${ip}]/`).hostname
    if (!hostname.startsWith('[') || !hostname.endsWith(']')) unavailable()
    return hostname.slice(1, -1)
  } catch {
    return unavailable()
  }
}

/** Account, IP, and service keys deliberately exclude configuration revision and window length. */
export async function clientSecurityBucketKeys(principal: FirebaseClientIdentity, ip: string) {
  if (
    !principal ||
    typeof principal.uid !== 'string' ||
    !principal.uid.length ||
    principal.uid.length > 128 ||
    principal.uid.trim() !== principal.uid ||
    /[\u0000-\u001f\u007f]/.test(principal.uid) ||
    typeof principal.projectId !== 'string' ||
    !principal.projectId.length
  )
    unavailable()
  const normalizedIp = canonicalClientSecurityIp(ip)
  return Object.freeze({
    uid: await hash(['uid', principal.projectId, principal.uid]),
    ip: await hash(['ip', normalizedIp]),
    global: await hash(['global']),
  })
}

interface AdmissionRow {
  revision: unknown
  digest: unknown
  configuration: unknown
  admission_nonce: unknown
  admission_allowed: unknown
  uid_key: unknown
  ip_key: unknown
  global_key: unknown
  uid_used: unknown
  ip_used: unknown
  global_used: unknown
  uid_reset_at: unknown
  ip_reset_at: unknown
  global_reset_at: unknown
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** A single D1 transaction pins trust/configuration, decides all dimensions, then increments all. */
export function createClientSecurityRateLimiter(
  db: ClientSecurityDatabase,
  { nowMs = Date.now }: ClientSecurityRateLimitDependencies = {},
) {
  async function admit({
    snapshot,
    principal,
    ip,
  }: ClientSecurityAdmission): Promise<ClientSecurityAdmissionResult> {
    let configuration, canonical, digest, keys
    try {
      configuration = validateClientSecurityConfiguration(snapshot?.configuration)
      canonical = canonicalClientSecurityConfiguration(configuration)
      digest = await digestClientSecurityConfiguration(configuration)
      if (
        !configuration.firebase.enabled ||
        snapshot.digest !== digest ||
        !nonnegativeInteger(snapshot.revision) ||
        principal.projectId !== configuration.firebase.projectId ||
        !configuration.firebase.appIds.includes(principal.appId)
      )
        unavailable()
      keys = await clientSecurityBucketKeys(principal, ip)
    } catch {
      return unavailable()
    }
    const milliseconds = nowMs(),
      now = Math.floor(milliseconds / 1000)
    if (
      !nonnegativeInteger(milliseconds) ||
      !nonnegativeInteger(now) ||
      now > Number.MAX_SAFE_INTEGER - 3600
    )
      unavailable()
    const resetAt = now + configuration.limits.windowSeconds,
      nonce = crypto.randomUUID()
    const values = [snapshot.revision, digest, canonical]
    const pinned = `EXISTS (SELECT 1 FROM client_security_state s
      JOIN client_security_versions v ON v.revision = s.revision
      WHERE s.id = 1 AND s.revision = ? AND v.digest = ? AND v.configuration = ?)`
    const healthy = `NOT EXISTS (SELECT 1 FROM client_security_counters
      WHERE bucket_key IN (?, ?, ?) AND (
        typeof(used) NOT IN ('integer', 'real') OR used < 0 OR used > 9007199254740991 OR used != CAST(used AS INTEGER)
        OR typeof(reset_at) NOT IN ('integer', 'real') OR reset_at < 0 OR reset_at > 9007199254740991 OR reset_at != CAST(reset_at AS INTEGER)))`
    const bucketValues = [keys.uid, keys.ip, keys.global]
    const statements: D1PreparedStatement[] = []
    // This decision is stored independently of counters. Subsequent writes cannot change it.
    statements.push(
      db
        .prepare(
          `UPDATE client_security_state SET admission_nonce = ?, admission_allowed = CASE WHEN
        COALESCE((SELECT CASE WHEN reset_at <= ? THEN 0 ELSE used END FROM client_security_counters WHERE bucket_key = ?), 0) < ?
        AND COALESCE((SELECT CASE WHEN reset_at <= ? THEN 0 ELSE used END FROM client_security_counters WHERE bucket_key = ?), 0) < ?
        AND COALESCE((SELECT CASE WHEN reset_at <= ? THEN 0 ELSE used END FROM client_security_counters WHERE bucket_key = ?), 0) < ? THEN 1 ELSE 0 END
      WHERE id = 1 AND ${pinned} AND ${healthy}`,
        )
        .bind(
          nonce,
          now,
          keys.uid,
          configuration.limits.uid,
          now,
          keys.ip,
          configuration.limits.ip,
          now,
          keys.global,
          configuration.limits.global,
          ...values,
          ...bucketValues,
        ),
    )
    const admitted = `EXISTS (SELECT 1 FROM client_security_state WHERE id = 1 AND admission_nonce = ? AND admission_allowed = 1)`
    // A blocked anonymous identity cannot grow the counter table with unused buckets.
    for (const key of bucketValues) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO client_security_counters (bucket_key, used, reset_at)
        SELECT ?, 0, ? WHERE ${admitted}`,
          )
          .bind(key, resetAt, nonce),
      )
    }
    statements.push(
      db
        .prepare(
          `UPDATE client_security_counters SET used = 0, reset_at = ?
      WHERE bucket_key IN (?, ?, ?) AND reset_at <= ? AND ${admitted}`,
        )
        .bind(resetAt, ...bucketValues, now, nonce),
    )
    statements.push(
      db
        .prepare(
          `UPDATE client_security_counters SET used = used + 1
      WHERE bucket_key IN (?, ?, ?) AND EXISTS (SELECT 1 FROM client_security_state
        WHERE id = 1 AND admission_nonce = ? AND admission_allowed = 1)
        AND (SELECT COUNT(*) FROM client_security_counters WHERE bucket_key IN (?, ?, ?)) = 3`,
        )
        .bind(...bucketValues, nonce, ...bucketValues),
    )
    statements.push(
      db
        .prepare(
          `SELECT s.revision, s.admission_nonce, s.admission_allowed, v.digest, v.configuration,
        u.bucket_key AS uid_key, i.bucket_key AS ip_key, g.bucket_key AS global_key,
        COALESCE(CASE WHEN u.reset_at <= ? THEN 0 ELSE u.used END, 0) AS uid_used,
        COALESCE(CASE WHEN i.reset_at <= ? THEN 0 ELSE i.used END, 0) AS ip_used,
        COALESCE(CASE WHEN g.reset_at <= ? THEN 0 ELSE g.used END, 0) AS global_used,
        CASE WHEN u.reset_at IS NULL OR u.reset_at <= ? THEN ? ELSE u.reset_at END AS uid_reset_at,
        CASE WHEN i.reset_at IS NULL OR i.reset_at <= ? THEN ? ELSE i.reset_at END AS ip_reset_at,
        CASE WHEN g.reset_at IS NULL OR g.reset_at <= ? THEN ? ELSE g.reset_at END AS global_reset_at
      FROM client_security_state s JOIN client_security_versions v ON v.revision = s.revision
      LEFT JOIN client_security_counters u ON u.bucket_key = ?
      LEFT JOIN client_security_counters i ON i.bucket_key = ?
      LEFT JOIN client_security_counters g ON g.bucket_key = ? WHERE s.id = 1`,
        )
        .bind(now, now, now, now, resetAt, now, resetAt, now, resetAt, ...bucketValues),
    )
    let results: D1Result<AdmissionRow>[]
    try {
      results = await db.batch<AdmissionRow>(statements)
      if (results.length !== statements.length || results.some((result) => !result.success))
        unavailable()
    } catch {
      return unavailable()
    }
    const row = results.at(-1)?.results?.[0]
    if (
      !row ||
      row.admission_nonce !== nonce ||
      row.revision !== snapshot.revision ||
      row.digest !== digest ||
      row.configuration !== canonical ||
      (row.admission_allowed !== 0 && row.admission_allowed !== 1)
    )
      unavailable()
    if (
      row.admission_allowed === 1 &&
      (row.uid_key !== keys.uid || row.ip_key !== keys.ip || row.global_key !== keys.global)
    )
      unavailable()
    const used = { uid: row.uid_used, ip: row.ip_used, global: row.global_used }
    const resets = { uid: row.uid_reset_at, ip: row.ip_reset_at, global: row.global_reset_at }
    for (const dimension of ['uid', 'ip', 'global'] as const)
      if (
        !nonnegativeInteger(used[dimension]) ||
        !nonnegativeInteger(resets[dimension]) ||
        resets[dimension] <= now
      )
        unavailable()
    if (row.admission_allowed === 0) {
      const deadlines = (['uid', 'ip', 'global'] as const)
        .filter((dimension) => (used[dimension] as number) >= configuration.limits[dimension])
        .map((dimension) => (resets[dimension] as number) - now)
      if (!deadlines.length) unavailable()
      throw new ClientSecurityRateLimitError(
        429,
        'client_security_rate_limited',
        Math.max(1, ...deadlines),
      )
    }
    return Object.freeze({
      allowed: true,
      remaining: Object.freeze({
        uid: Math.max(0, configuration.limits.uid - (used.uid as number)),
        ip: Math.max(0, configuration.limits.ip - (used.ip as number)),
        global: Math.max(0, configuration.limits.global - (used.global as number)),
      }),
      resetAt: Object.freeze(resets as Record<'uid' | 'ip' | 'global', number>),
    })
  }
  return { admit }
}
export type ClientSecurityRateLimiter = ReturnType<typeof createClientSecurityRateLimiter>
