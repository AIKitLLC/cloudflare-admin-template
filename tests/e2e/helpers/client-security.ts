import type { APIRequestContext } from '@playwright/test'

import { api, type ApiResult } from './api'

/** The origin the Worker sees as its own; see `scripts/e2e/serve-worker.mjs`. */
export const ORIGIN = `http://localhost:${process.env.E2E_PORT ?? 8792}`

/** What revision 0 holds: disabled, blank identifiers, zero limits. */
export const DEFAULT_CONFIGURATION = {
  schemaVersion: 1,
  firebase: { enabled: false, projectId: '', projectNumber: '', appIds: [] as string[] },
  limits: { windowSeconds: 60, uid: 0, ip: 0, global: 0 },
}

/** A complete, enabled configuration. The App ID must carry the project number. */
export const VALID_CONFIGURATION = {
  schemaVersion: 1,
  firebase: {
    enabled: true,
    projectId: 'e2e-project',
    projectNumber: '123456789',
    appIds: ['1:123456789:android:abcdef123456'],
  },
  limits: { windowSeconds: 60, uid: 5, ip: 10, global: 100 },
}

const ENDPOINT = '/api/admin/client-security'

/** The headers a same-origin browser write carries. */
export const manageHeaders = { 'x-client-security-action': 'manage', origin: ORIGIN }

export type Settings = {
  snapshot: { revision: number; configuration: typeof DEFAULT_CONFIGURATION; digest: string }
  readiness: { ready: boolean; reasons: string[] }
  history: { revision: number; operation: string; actor: string }[]
}

/** `GET` the settings as the given user. Throws unless the answer is 200. */
export async function readSettings(request: APIRequestContext, token: string): Promise<Settings> {
  const result = await api(request, { method: 'GET', path: ENDPOINT, token })
  if (result.status !== 200) throw new Error(`Reading settings answered ${result.status}`)
  return result.body as Settings
}

/** One write with the same-origin headers unless `headers` replaces them. */
export function writeSettings(
  request: APIRequestContext,
  token: string,
  data: Record<string, unknown>,
  headers: Record<string, string> = manageHeaders,
): Promise<ApiResult> {
  return api(request, { method: 'POST', path: ENDPOINT, token, data, headers })
}

/** Preview then save `configuration` at the current revision. Returns the saved revision. */
export async function saveConfiguration(
  request: APIRequestContext,
  token: string,
  configuration: unknown,
): Promise<number> {
  const { snapshot } = await readSettings(request, token)
  const preview = await writeSettings(request, token, {
    action: 'preview',
    expectedRevision: snapshot.revision,
    configuration,
  })
  if (preview.status !== 200)
    throw new Error(`Previewing answered ${preview.status}: ${preview.message}`)
  const saved = await writeSettings(request, token, {
    action: 'save',
    expectedRevision: snapshot.revision,
    configuration,
    reviewedDigest: preview.body.digest,
  })
  if (saved.status !== 200) throw new Error(`Saving answered ${saved.status}: ${saved.message}`)
  return saved.body.snapshot.revision as number
}

/** Puts revision 0's content back (as a new revision) unless it is already current. */
export async function restoreDefaults(request: APIRequestContext, token: string): Promise<void> {
  const { snapshot } = await readSettings(request, token)
  if (JSON.stringify(snapshot.configuration) === JSON.stringify(DEFAULT_CONFIGURATION)) return
  const body = { expectedRevision: snapshot.revision, rollbackRevision: 0 }
  const preview = await writeSettings(request, token, { action: 'previewRollback', ...body })
  if (preview.status !== 200) throw new Error(`Previewing the rollback answered ${preview.status}`)
  const done = await writeSettings(request, token, {
    action: 'rollback',
    ...body,
    reviewedDigest: preview.body.digest,
  })
  if (done.status !== 200) throw new Error(`Rolling back answered ${done.status}: ${done.message}`)
}
