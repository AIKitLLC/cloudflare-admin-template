import {
  canonicalClientSecurityConfiguration,
  clientSecurityReadiness,
  digestClientSecurityConfiguration,
  validateClientSecurityConfiguration,
  type ClientSecurityConfiguration,
} from './schema'

export type ClientSecurityDatabase = Pick<D1Database, 'prepare' | 'batch'>
export interface ClientSecuritySnapshot {
  readonly revision: number
  readonly configuration: ClientSecurityConfiguration
  readonly digest: string
}
export interface ClientSecurityVersion extends ClientSecuritySnapshot {
  readonly actor: string
  readonly operation: 'initialize' | 'save' | 'rollback'
  readonly createdAt: string
}
export interface ClientSecuritySave {
  expectedRevision: number
  configuration: unknown
  reviewedDigest: string
  actor: string
  operation: 'save' | 'rollback'
  rollbackRevision?: number
}
export type ClientSecurityStoreReason =
  | 'client_security_invalid_revision'
  | 'client_security_invalid_actor'
  | 'client_security_invalid_operation'
  | 'client_security_review_required'
  | 'client_security_unknown_revision'
  | 'client_security_revision_conflict'
  | 'client_security_unavailable'
  | 'client_security_corrupt'

export class ClientSecurityStoreError extends Error {
  readonly code: ClientSecurityStoreReason
  constructor(
    readonly status: 400 | 409 | 503,
    readonly reason: ClientSecurityStoreReason,
  ) {
    super(reason)
    this.name = 'ClientSecurityStoreError'
    this.code = reason
  }
}

export interface ClientSecurityStoreDependencies {
  nowMs?: () => number
}

function unavailable(): never {
  throw new ClientSecurityStoreError(503, 'client_security_unavailable')
}
function corrupt(): never {
  throw new ClientSecurityStoreError(503, 'client_security_corrupt')
}
function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
function assertRevision(value: unknown): asserts value is number {
  if (!validRevision(value))
    throw new ClientSecurityStoreError(400, 'client_security_invalid_revision')
}
function validActor(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,128}$/.test(value)
}

interface VersionRow {
  revision: unknown
  configuration: unknown
  digest: unknown
  actor?: unknown
  operation?: unknown
  created_at?: unknown
  state_revision?: unknown
  commit_nonce?: unknown
}

async function snapshotFromRow(row: VersionRow | null): Promise<ClientSecuritySnapshot> {
  if (
    !row ||
    !validRevision(row.revision) ||
    typeof row.configuration !== 'string' ||
    row.configuration.length > 8192 ||
    typeof row.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.digest)
  )
    corrupt()
  try {
    const configuration = validateClientSecurityConfiguration(JSON.parse(row.configuration))
    if ((await digestClientSecurityConfiguration(configuration)) !== row.digest) corrupt()
    return Object.freeze({ revision: row.revision, configuration, digest: row.digest })
  } catch {
    return corrupt()
  }
}

const CURRENT_VERSION_SQL = `SELECT s.revision AS state_revision, s.commit_nonce,
  v.revision, v.configuration, v.digest FROM client_security_state s
  LEFT JOIN client_security_versions v ON v.revision = s.revision WHERE s.id = 1`

/** Uses pre-migrated D1 tables. Configuration, history, and audit commit in one transaction. */
export function createClientSecurityStore(
  db: ClientSecurityDatabase,
  { nowMs = Date.now }: ClientSecurityStoreDependencies = {},
) {
  async function first(sql: string, values: (string | number)[] = []): Promise<VersionRow | null> {
    try {
      return await db
        .prepare(sql)
        .bind(...values)
        .first<VersionRow>()
    } catch {
      return unavailable()
    }
  }

  async function read(): Promise<ClientSecuritySnapshot> {
    const row = await first(CURRENT_VERSION_SQL)
    if (!row) unavailable()
    if (!validRevision(row.state_revision) || row.state_revision !== row.revision) corrupt()
    return snapshotFromRow(row)
  }

  async function readVersion(revision: number): Promise<ClientSecurityVersion> {
    assertRevision(revision)
    const row = await first(
      `SELECT revision, configuration, digest, actor, operation, created_at
      FROM client_security_versions WHERE revision = ?`,
      [revision],
    )
    if (!row) throw new ClientSecurityStoreError(400, 'client_security_unknown_revision')
    return versionFromRow(row)
  }

  async function versionFromRow(row: VersionRow): Promise<ClientSecurityVersion> {
    const snapshot = await snapshotFromRow(row)
    if (
      !validActor(row.actor) ||
      !['initialize', 'save', 'rollback'].includes(String(row.operation)) ||
      typeof row.created_at !== 'string' ||
      !Number.isFinite(Date.parse(row.created_at))
    )
      corrupt()
    return Object.freeze({
      ...snapshot,
      actor: row.actor,
      operation: row.operation as ClientSecurityVersion['operation'],
      createdAt: row.created_at,
    })
  }

  async function history(limit = 20): Promise<readonly ClientSecurityVersion[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      throw new ClientSecurityStoreError(400, 'client_security_invalid_revision')
    let rows: VersionRow[]
    try {
      const result = await db
        .prepare(
          `SELECT revision, configuration, digest, actor, operation, created_at
        FROM client_security_versions ORDER BY revision DESC LIMIT ?`,
        )
        .bind(limit)
        .all<VersionRow>()
      if (!result.success || !Array.isArray(result.results)) unavailable()
      rows = result.results
    } catch {
      return unavailable()
    }
    return Object.freeze(await Promise.all(rows.map(versionFromRow)))
  }

  async function preview(input: unknown) {
    const configuration = validateClientSecurityConfiguration(input)
    const canonical = canonicalClientSecurityConfiguration(configuration)
    const digest = await digestClientSecurityConfiguration(configuration)
    const current = await read()
    return Object.freeze({
      configuration,
      canonical,
      digest,
      readiness: clientSecurityReadiness(configuration),
      currentRevision: current.revision,
      changed: digest !== current.digest,
    })
  }

  async function save(input: ClientSecuritySave): Promise<ClientSecuritySnapshot> {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            'expectedRevision',
            'configuration',
            'reviewedDigest',
            'actor',
            'operation',
            'rollbackRevision',
          ].includes(key),
      )
    )
      throw new ClientSecurityStoreError(400, 'client_security_invalid_operation')
    assertRevision(input.expectedRevision)
    if (input.expectedRevision >= Number.MAX_SAFE_INTEGER)
      throw new ClientSecurityStoreError(400, 'client_security_invalid_revision')
    if (!validActor(input.actor))
      throw new ClientSecurityStoreError(400, 'client_security_invalid_actor')
    if (
      (input.operation !== 'save' && input.operation !== 'rollback') ||
      (input.operation === 'save' && input.rollbackRevision !== undefined) ||
      (input.operation === 'rollback' && !validRevision(input.rollbackRevision))
    )
      throw new ClientSecurityStoreError(400, 'client_security_invalid_operation')
    const configuration = validateClientSecurityConfiguration(input.configuration)
    const digest = await digestClientSecurityConfiguration(configuration)
    if (input.reviewedDigest !== digest)
      throw new ClientSecurityStoreError(400, 'client_security_review_required')
    if (input.operation === 'rollback') {
      const historical = await readVersion(input.rollbackRevision!)
      if (historical.digest !== digest)
        throw new ClientSecurityStoreError(400, 'client_security_review_required')
    }
    // Validate the current durable version before attempting a state transition.
    const current = await read()
    if (current.revision !== input.expectedRevision)
      throw new ClientSecurityStoreError(409, 'client_security_revision_conflict')
    const now = nowMs()
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime()))
      unavailable()
    const createdAt = new Date(now).toISOString(),
      nonce = crypto.randomUUID(),
      revision = input.expectedRevision + 1
    const canonical = canonicalClientSecurityConfiguration(configuration)
    let result: D1Result<VersionRow>[]
    try {
      result = await db.batch<VersionRow>([
        db
          .prepare(
            `UPDATE client_security_state SET revision = ?, commit_nonce = ?
          WHERE id = 1 AND revision = ? AND EXISTS (SELECT 1 FROM client_security_versions
            WHERE revision = ? AND digest = ? AND configuration = ?)`,
          )
          .bind(
            revision,
            nonce,
            input.expectedRevision,
            input.expectedRevision,
            current.digest,
            canonicalClientSecurityConfiguration(current.configuration),
          ),
        db
          .prepare(
            `INSERT INTO client_security_versions (revision, configuration, digest, actor, operation, created_at)
          SELECT ?, ?, ?, ?, ?, ? FROM client_security_state
          WHERE id = 1 AND revision = ? AND commit_nonce = ?`,
          )
          .bind(
            revision,
            canonical,
            digest,
            input.actor,
            input.operation,
            createdAt,
            revision,
            nonce,
          ),
        db
          .prepare(
            `INSERT INTO client_security_audit (revision, actor, operation, created_at, previous_revision)
          SELECT ?, ?, ?, ?, ? FROM client_security_state
          WHERE id = 1 AND revision = ? AND commit_nonce = ?`,
          )
          .bind(
            revision,
            input.actor,
            input.operation,
            createdAt,
            input.expectedRevision,
            revision,
            nonce,
          ),
        db.prepare(CURRENT_VERSION_SQL),
      ])
      if (result.length !== 4 || result.some((item) => !item.success)) unavailable()
    } catch {
      return unavailable()
    }
    const row = result[3].results?.[0]
    if (!row) unavailable()
    if (row.commit_nonce !== nonce && row.state_revision === input.expectedRevision) corrupt()
    if (row.commit_nonce !== nonce || row.state_revision !== revision)
      throw new ClientSecurityStoreError(409, 'client_security_revision_conflict')
    const saved = await snapshotFromRow(row)
    if (saved.revision !== revision || saved.digest !== digest) corrupt()
    return saved
  }

  return { read, preview, readVersion, history, save }
}
export type ClientSecurityStore = ReturnType<typeof createClientSecurityStore>
