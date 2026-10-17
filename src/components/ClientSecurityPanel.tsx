'use client'

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'

import type { ClientSecurityConfiguration } from '@/client-security/schema'

type Readiness = { ready: boolean; reasons: string[] }
type Snapshot = {
  revision: number
  configuration: ClientSecurityConfiguration
  digest: string
}
type HistoryEntry = {
  revision: number
  actor: string
  operation: string
  createdAt: string
}
type SecurityState = { snapshot: Snapshot; readiness: Readiness; history: HistoryEntry[] }
type Change = { field: string; before: unknown; after: unknown }
type Preview = {
  configuration: ClientSecurityConfiguration
  digest: string
  readiness: Readiness
  currentRevision: number
  changed: boolean
  changes: Change[]
  mode: 'save' | 'rollback'
  rollbackRevision?: number
}
type Draft = {
  enabled: boolean
  projectId: string
  projectNumber: string
  appIds: string
  windowSeconds: string
  uid: string
  ip: string
  global: string
}

const endpoint = '/api/admin/client-security'
const emptyDraft: Draft = {
  enabled: false,
  projectId: '',
  projectNumber: '',
  appIds: '',
  windowSeconds: '60',
  uid: '0',
  ip: '0',
  global: '0',
}
const card: CSSProperties = {
  border: '1px solid var(--theme-elevation-200)',
  borderRadius: '4px',
  padding: '1.5rem',
  marginBlock: '1.5rem',
}
const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
  gap: '1.25rem',
}
const field: CSSProperties = { display: 'grid', gap: '0.5rem' }
const input: CSSProperties = {
  width: '100%',
  padding: '0.75rem',
  border: '1px solid var(--theme-elevation-300)',
  borderRadius: '3px',
  color: 'inherit',
  background: 'var(--theme-elevation-0)',
  font: 'inherit',
}
const button: CSSProperties = {
  padding: '0.75rem 1rem',
  border: '1px solid var(--theme-elevation-400)',
  borderRadius: '3px',
  color: 'inherit',
  background: 'var(--theme-elevation-100)',
  font: 'inherit',
  cursor: 'pointer',
}
const cell: CSSProperties = {
  textAlign: 'left',
  padding: '0.75rem',
  borderBottom: '1px solid var(--theme-elevation-200)',
  verticalAlign: 'top',
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
}
const fieldNames: Record<string, string> = {
  'firebase.enabled': 'Native client API',
  'firebase.projectId': 'Firebase project ID',
  'firebase.projectNumber': 'Firebase project number',
  'firebase.appIds': 'Allowed Firebase App IDs',
  'limits.windowSeconds': 'Quota window (seconds)',
  'limits.uid': 'Requests per UID',
  'limits.ip': 'Requests per IP',
  'limits.global': 'Requests across all clients',
}

class RequestError extends Error {
  constructor(readonly status: number) {
    super('Client security request failed')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
function isConfiguration(value: unknown): value is ClientSecurityConfiguration {
  if (!isRecord(value) || !isRecord(value.firebase) || !isRecord(value.limits)) return false
  const limits = value.limits
  return (
    value.schemaVersion === 1 &&
    typeof value.firebase.enabled === 'boolean' &&
    typeof value.firebase.projectId === 'string' &&
    typeof value.firebase.projectNumber === 'string' &&
    Array.isArray(value.firebase.appIds) &&
    value.firebase.appIds.every((item) => typeof item === 'string') &&
    ['windowSeconds', 'uid', 'ip', 'global'].every((key) => isRevision(limits[key]))
  )
}
function isReadiness(value: unknown): value is Readiness {
  return (
    isRecord(value) &&
    typeof value.ready === 'boolean' &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === 'string')
  )
}
function isSnapshot(value: unknown): value is Snapshot {
  return (
    isRecord(value) &&
    isRevision(value.revision) &&
    typeof value.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.digest) &&
    isConfiguration(value.configuration)
  )
}
function parseState(value: unknown): SecurityState {
  if (
    !isRecord(value) ||
    !isSnapshot(value.snapshot) ||
    !isReadiness(value.readiness) ||
    !Array.isArray(value.history) ||
    !value.history.every(
      (entry) =>
        isRecord(entry) &&
        isRevision(entry.revision) &&
        typeof entry.actor === 'string' &&
        typeof entry.operation === 'string' &&
        typeof entry.createdAt === 'string',
    )
  )
    throw new RequestError(502)
  return value as SecurityState
}
function parsePreview(value: unknown, mode: Preview['mode'], rollbackRevision?: number): Preview {
  if (
    !isRecord(value) ||
    !isConfiguration(value.configuration) ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    !isRevision(value.currentRevision) ||
    !isReadiness(value.readiness) ||
    typeof value.changed !== 'boolean' ||
    !Array.isArray(value.changes) ||
    !value.changes.every((change) => isRecord(change) && typeof change.field === 'string')
  )
    throw new RequestError(502)
  return { ...value, mode, rollbackRevision } as Preview
}
function toDraft(configuration: ClientSecurityConfiguration): Draft {
  return {
    ...configuration.firebase,
    appIds: configuration.firebase.appIds.join('\n'),
    windowSeconds: String(configuration.limits.windowSeconds),
    uid: String(configuration.limits.uid),
    ip: String(configuration.limits.ip),
    global: String(configuration.limits.global),
  }
}
function toConfiguration(draft: Draft): ClientSecurityConfiguration {
  const limit = (key: 'windowSeconds' | 'uid' | 'ip' | 'global') => {
    if (!/^\d+$/.test(draft[key])) throw new Error('Enter whole-number request limits.')
    const value = Number(draft[key])
    if (!Number.isSafeInteger(value)) throw new Error('Enter whole-number request limits.')
    return value
  }
  return {
    schemaVersion: 1,
    firebase: {
      enabled: draft.enabled,
      projectId: draft.projectId.trim(),
      projectNumber: draft.projectNumber.trim(),
      appIds: draft.appIds
        .split(/[\n,]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    },
    limits: {
      windowSeconds: limit('windowSeconds'),
      uid: limit('uid'),
      ip: limit('ip'),
      global: limit('global'),
    },
  }
}
function display(value: unknown): string {
  if (value === true) return 'Enabled'
  if (value === false) return 'Disabled'
  if (Array.isArray(value)) return value.length ? value.map(display).join('\n') : 'Not configured'
  if (value === '' || value === undefined || value === null) return 'Not configured'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
function configurationValues(configuration: ClientSecurityConfiguration): Record<string, unknown> {
  return {
    'firebase.enabled': configuration.firebase.enabled,
    'firebase.projectId': configuration.firebase.projectId,
    'firebase.projectNumber': configuration.firebase.projectNumber,
    'firebase.appIds': configuration.firebase.appIds,
    'limits.windowSeconds': configuration.limits.windowSeconds,
    'limits.uid': configuration.limits.uid,
    'limits.ip': configuration.limits.ip,
    'limits.global': configuration.limits.global,
  }
}
function readinessMessages(configuration: ClientSecurityConfiguration, readiness: Readiness) {
  const messages: string[] = []
  if (!configuration.firebase.enabled) messages.push('Client access is disabled.')
  if (
    !configuration.firebase.projectId ||
    !configuration.firebase.projectNumber ||
    !configuration.firebase.appIds.length
  )
    messages.push('Public Firebase identifiers are missing.')
  const zeroLimits = ['uid', 'ip', 'global'].filter(
    (key) => configuration.limits[key as 'uid' | 'ip' | 'global'] === 0,
  )
  if (zeroLimits.length) {
    const names: Record<string, string> = { uid: 'UID', ip: 'IP', global: 'all clients' }
    messages.push(`Zero quotas block requests: ${zeroLimits.map((key) => names[key]).join(', ')}.`)
  }
  if (readiness.reasons.includes('client_security_invalid_configuration')) {
    messages.push('The configuration is incomplete or invalid.')
  }
  if (!readiness.ready && !messages.length) messages.push('Client access is not ready.')
  return messages
}

async function api(body?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body
      ? { 'Content-Type': 'application/json', 'X-Client-Security-Action': 'manage' }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new RequestError(response.status)
  try {
    return await response.json()
  } catch {
    throw new RequestError(502)
  }
}

export function ClientSecurityPanel() {
  const [state, setState] = useState<SecurityState | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [reviewed, setReviewed] = useState(false)
  const [rollbackRevision, setRollbackRevision] = useState('')
  const [busy, setBusy] = useState(true)
  const [stale, setStale] = useState(false)
  const [denied, setDenied] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const pending = useRef<{ token: symbol; signal?: AbortSignal } | null>(null)

  const invalidatePreview = () => {
    setPreview(null)
    setReviewed(false)
    setMessage('')
    setError('')
  }
  const failure = useCallback((reason: unknown) => {
    setPreview(null)
    setReviewed(false)
    if (reason instanceof RequestError && [401, 403].includes(reason.status)) {
      setDenied(true)
      setState(null)
      setError('Only an authenticated owner can access these settings.')
    } else if (reason instanceof RequestError && reason.status === 409) {
      setStale(true)
      setError(
        'Another owner updated these settings. Reload saved settings to discard this draft, then preview again.',
      )
    } else if (reason instanceof RequestError && reason.status === 400) {
      setError(
        'The server rejected this change. Check the public Firebase identifiers and request limits, then preview again.',
      )
    } else if (reason instanceof Error && reason.message === 'Enter whole-number request limits.') {
      setError(reason.message)
    } else {
      setError('The request could not be completed. Reload saved settings before trying again.')
    }
  }, [])
  const applyState = useCallback((value: SecurityState) => {
    setState(value)
    setDraft(toDraft(value.snapshot.configuration))
    setPreview(null)
    setReviewed(false)
    setRollbackRevision('')
    setStale(false)
  }, [])
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      if (pending.current && !pending.current.signal?.aborted) return
      const token = Symbol('reload')
      pending.current = { token, signal }
      setBusy(true)
      setError('')
      setMessage('')
      try {
        const value = parseState(await api(undefined, signal))
        if (!signal?.aborted) applyState(value)
      } catch (reason) {
        if (!signal?.aborted) failure(reason)
      } finally {
        if (pending.current?.token === token) {
          pending.current = null
          if (!signal?.aborted) setBusy(false)
        }
      }
    },
    [applyState, failure],
  )
  useEffect(() => {
    const controller = new AbortController()
    const token = Symbol('initial-load')
    pending.current = { token, signal: controller.signal }
    void api(undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) applyState(parseState(value))
      })
      .catch((reason) => {
        if (!controller.signal.aborted) failure(reason)
      })
      .finally(() => {
        if (pending.current?.token === token) {
          pending.current = null
          if (!controller.signal.aborted) setBusy(false)
        }
      })
    return () => controller.abort()
  }, [applyState, failure])

  async function requestPreview(mode: Preview['mode']) {
    if (!state || stale || pending.current) return
    const token = Symbol('preview')
    pending.current = { token }
    setBusy(true)
    invalidatePreview()
    try {
      const selectedRevision = mode === 'rollback' ? Number(rollbackRevision) : undefined
      if (mode === 'rollback' && (!rollbackRevision || !isRevision(selectedRevision))) {
        throw new RequestError(400)
      }
      const body =
        mode === 'rollback'
          ? {
              action: 'previewRollback',
              expectedRevision: state.snapshot.revision,
              rollbackRevision: selectedRevision,
            }
          : {
              action: 'preview',
              expectedRevision: state.snapshot.revision,
              configuration: toConfiguration(draft),
            }
      const value = parsePreview(await api(body), mode, selectedRevision)
      if (value.currentRevision !== state.snapshot.revision) throw new RequestError(409)
      setPreview(value)
    } catch (reason) {
      failure(reason)
    } finally {
      if (pending.current?.token === token) pending.current = null
      setBusy(false)
    }
  }
  async function commitPreview() {
    if (!state || !preview || !reviewed || stale || pending.current) return
    if (preview.currentRevision !== state.snapshot.revision) {
      failure(new RequestError(409))
      return
    }
    const token = Symbol('commit')
    pending.current = { token }
    setBusy(true)
    setError('')
    setMessage('')
    let committed = false
    try {
      const body =
        preview.mode === 'rollback'
          ? {
              action: 'rollback',
              expectedRevision: preview.currentRevision,
              rollbackRevision: preview.rollbackRevision,
              reviewedDigest: preview.digest,
            }
          : {
              action: 'save',
              expectedRevision: preview.currentRevision,
              configuration: preview.configuration,
              reviewedDigest: preview.digest,
            }
      await api(body)
      committed = true
      const updated = parseState(await api())
      applyState(updated)
      setMessage(
        `Saved revision ${updated.snapshot.revision}. Existing quota counters are preserved.`,
      )
    } catch (reason) {
      failure(reason)
      // A timed-out write may have committed. Force an explicit read before another write.
      if (!(reason instanceof RequestError) || reason.status >= 500 || committed) {
        setStale(true)
        setError(
          committed
            ? 'The change was saved, but the saved state could not be reloaded. Reload saved settings before continuing.'
            : 'The save result is unknown. Reload saved settings before making another change.',
        )
      }
    } finally {
      setPreview(null)
      setReviewed(false)
      if (pending.current?.token === token) pending.current = null
      setBusy(false)
    }
  }
  function edit<K extends keyof Draft>(key: K, value: Draft[K]) {
    invalidatePreview()
    setDraft((current) => ({ ...current, [key]: value }))
  }

  if (denied) {
    return (
      <section className="gutter" style={{ paddingBlock: '2rem' }}>
        <h1>Access denied</h1>
        <p>{error}</p>
      </section>
    )
  }
  const locked = busy || stale
  const activeConfiguration = preview?.configuration ?? state?.snapshot.configuration
  const activeReadiness = preview?.readiness ?? state?.readiness
  const messages =
    activeConfiguration && activeReadiness
      ? readinessMessages(activeConfiguration, activeReadiness)
      : []

  return (
    <section
      className="gutter client-security-panel"
      style={{ paddingBlock: '2rem', maxWidth: '1100px' }}
    >
      <style>{`.client-security-panel button:disabled { opacity: .5; cursor: default; }`}</style>
      <h1>Client security</h1>
      <p>
        Manage Firebase Anonymous client access and request limits. Administrator sign-in remains
        separate.
      </p>
      <p>Preview every change, then review it before saving. Reloading discards unsaved edits.</p>
      {message && (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button type="button" style={button} disabled={busy} onClick={() => void reload()}>
        Reload saved settings
      </button>
      {!state && (
        <p role="status">{busy ? 'Loading saved settings…' : 'Saved settings are unavailable.'}</p>
      )}
      {state && (
        <>
          <div style={card} aria-live="polite">
            <h2>{preview ? 'Preview readiness' : 'Current readiness'}</h2>
            <p>
              Saved revision {state.snapshot.revision}.{' '}
              {preview
                ? activeReadiness?.ready
                  ? 'This preview would allow client access.'
                  : 'This preview would block client access.'
                : activeReadiness?.ready
                  ? 'Client access is ready.'
                  : 'Client access is blocked.'}
            </p>
            {messages.length > 0 && (
              <ul>
                {messages.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void requestPreview('save')
            }}
          >
            <fieldset disabled={locked} style={card}>
              <legend>Public Firebase configuration</legend>
              <p>
                Use the exact public identifiers from your Firebase project. No tokens, private
                keys, or service-account credentials are needed.
              </p>
              <p>When disabled, leave all identifiers blank or supply a complete configuration.</p>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  marginBottom: '1.5rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => edit('enabled', event.target.checked)}
                />
                Enable the native client API
              </label>
              <div style={grid}>
                <label style={field}>
                  Firebase project ID
                  <input
                    style={input}
                    value={draft.projectId}
                    maxLength={30}
                    autoComplete="off"
                    spellCheck={false}
                    required={draft.enabled}
                    onChange={(event) => edit('projectId', event.target.value)}
                  />
                </label>
                <label style={field}>
                  Firebase project number
                  <input
                    style={input}
                    value={draft.projectNumber}
                    maxLength={20}
                    inputMode="numeric"
                    autoComplete="off"
                    spellCheck={false}
                    required={draft.enabled}
                    onChange={(event) => edit('projectNumber', event.target.value)}
                  />
                </label>
              </div>
              <label style={{ ...field, marginTop: '1.25rem' }}>
                Allowed Firebase App IDs
                <textarea
                  style={input}
                  rows={4}
                  value={draft.appIds}
                  maxLength={4096}
                  autoComplete="off"
                  spellCheck={false}
                  required={draft.enabled}
                  onChange={(event) => edit('appIds', event.target.value)}
                />
                <span>
                  One App ID per line, up to 20. Every App ID must belong to the specified project
                  number.
                </span>
              </label>
            </fieldset>
            <fieldset disabled={locked} style={card}>
              <legend>Request limits</legend>
              <p>
                Limits apply within the same window. A zero limit blocks client requests. Enabling
                access requires all three limits to be positive.
              </p>
              <div style={grid}>
                {(['windowSeconds', 'uid', 'ip', 'global'] as const).map((key) => (
                  <label style={field} key={key}>
                    {fieldNames[`limits.${key}`]}
                    <input
                      style={input}
                      type="number"
                      min={key === 'windowSeconds' ? 10 : draft.enabled ? 1 : 0}
                      max={key === 'windowSeconds' ? 3600 : 1_000_000}
                      step={1}
                      required
                      value={draft[key]}
                      onChange={(event) => edit(key, event.target.value)}
                    />
                  </label>
                ))}
              </div>
              <p>
                Changing limits or rolling back settings does not clear existing quota counters.
              </p>
            </fieldset>
            <button type="submit" style={button} disabled={locked}>
              Preview changes
            </button>
          </form>
          {preview && (
            <div style={card}>
              <h2>
                {preview.mode === 'rollback'
                  ? `Review rollback to revision ${preview.rollbackRevision}`
                  : 'Review changes'}
              </h2>
              <p>
                {preview.mode === 'rollback'
                  ? 'This restores the selected configuration as a new revision.'
                  : 'Saving creates a new revision.'}{' '}
                Review the trust settings and limits before continuing.
              </p>
              {!preview.changed && <p>The proposed settings match the current revision.</p>}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th scope="col" style={cell}>
                        Setting
                      </th>
                      <th scope="col" style={cell}>
                        Current
                      </th>
                      <th scope="col" style={cell}>
                        Proposed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(fieldNames).map(([key, label]) => (
                      <tr key={key}>
                        <th scope="row" style={cell}>
                          {label}
                        </th>
                        <td style={cell}>
                          {display(configurationValues(state.snapshot.configuration)[key])}
                        </td>
                        <td style={cell}>
                          {display(configurationValues(preview.configuration)[key])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label
                style={{
                  display: 'flex',
                  gap: '0.75rem',
                  alignItems: 'flex-start',
                  marginBlock: '1.5rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={locked}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                <span>
                  I reviewed these Firebase trust settings and request limits, including any
                  activation or increase.
                </span>
              </label>
              <button
                type="button"
                style={button}
                disabled={locked || !reviewed}
                onClick={() => void commitPreview()}
              >
                {preview.mode === 'rollback'
                  ? 'Restore reviewed settings'
                  : 'Save reviewed settings'}
              </button>
            </div>
          )}
          <div style={card}>
            <h2>Revision history</h2>
            <p>
              The latest 20 revisions are shown. Rollback creates a new revision and preserves quota
              counters.
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th scope="col" style={cell}>
                      Revision
                    </th>
                    <th scope="col" style={cell}>
                      Operation
                    </th>
                    <th scope="col" style={cell}>
                      Actor
                    </th>
                    <th scope="col" style={cell}>
                      Time
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.history.slice(0, 20).map((entry) => (
                    <tr key={entry.revision}>
                      <td style={cell}>{entry.revision}</td>
                      <td style={cell}>{entry.operation}</td>
                      <td style={cell}>{entry.actor}</td>
                      <td style={cell}>
                        {Number.isFinite(Date.parse(entry.createdAt))
                          ? new Date(entry.createdAt).toLocaleString()
                          : entry.createdAt}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label style={{ ...field, marginBlock: '1.25rem' }}>
              Revision to restore
              <select
                style={input}
                disabled={locked}
                value={rollbackRevision}
                onChange={(event) => {
                  invalidatePreview()
                  setRollbackRevision(event.target.value)
                }}
              >
                <option value="">Choose a prior revision</option>
                {state.history
                  .slice(0, 20)
                  .filter((entry) => entry.revision !== state.snapshot.revision)
                  .map((entry) => (
                    <option key={entry.revision} value={entry.revision}>
                      Revision {entry.revision} · {entry.operation} · {entry.createdAt}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              style={button}
              disabled={locked || !rollbackRevision}
              onClick={() => void requestPreview('rollback')}
            >
              Preview rollback
            </button>
          </div>
        </>
      )}
    </section>
  )
}
