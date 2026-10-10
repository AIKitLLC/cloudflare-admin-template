'use client'

import React, { useMemo, useState } from 'react'

export type JobMonitorRow = {
  attempt: number
  createdAt?: string
  error?: string | null
  finishedAt?: string | null
  id: number
  logs?: Array<{ at: string; message: string }> | null
  maxAttempts: number
  name: string
  payload?: unknown
  runAt?: string | null
  startedAt?: string | null
  status: string
  updatedAt?: string
}

type JobsDashboardProps = {
  apiRoute: string
  canRead: boolean
  canRetry: boolean
  canTrigger: boolean
  jobs: JobMonitorRow[]
  jobNames: string[]
}

export function JobsDashboard({
  apiRoute,
  canRead,
  canRetry,
  canTrigger,
  jobs,
  jobNames,
}: JobsDashboardProps) {
  const [rows, setRows] = useState(jobs)
  const [message, setMessage] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [jobName, setJobName] = useState(jobNames[0] ?? '')
  const [payloadText, setPayloadText] = useState('{}')
  const [pending, setPending] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)

  const visible = useMemo(
    () => (statusFilter === 'ALL' ? rows : rows.filter((row) => row.status === statusFilter)),
    [rows, statusFilter],
  )

  async function refresh() {
    const params = new URLSearchParams({ depth: '0', limit: '50', sort: '-createdAt' })
    if (statusFilter !== 'ALL') {
      params.set('where[status][equals]', statusFilter)
    }
    const response = await fetch(`${apiRoute}/jobs?${params.toString()}`, { credentials: 'include' })
    if (!response.ok) {
      throw new Error(await readError(response))
    }
    const body = (await response.json()) as { docs?: JobMonitorRow[] }
    setRows(body.docs ?? [])
  }

  async function trigger(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setMessage(null)
    try {
      const payload = JSON.parse(payloadText) as unknown
      const response = await fetch(`${apiRoute}/jobs/trigger`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: jobName, payload }),
      })
      if (!response.ok) {
        throw new Error(await readError(response))
      }
      setMessage('Job queued.')
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The job could not be queued.')
    } finally {
      setPending(false)
    }
  }

  async function retry(id: number) {
    setPending(true)
    setMessage(null)
    try {
      const response = await fetch(`${apiRoute}/jobs/${id}/retry`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!response.ok) {
        throw new Error(await readError(response))
      }
      setMessage('Failed job queued again.')
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The job could not be retried.')
    } finally {
      setPending(false)
    }
  }

  if (!canRead) {
    return (
      <div className="jobs-dashboard">
        <h1>Job monitor</h1>
        <p>You need permission to read jobs before this monitor is available.</p>
      </div>
    )
  }

  return (
    <div className="jobs-dashboard">
      <h1>Job monitor</h1>
      <p className="jobs-dashboard__intro">
        Registered jobs run from Cloudflare Queues. Payloads, errors, and logs are redacted and size-capped
        before they are stored. Trigger and retry are separate permissions from viewing.
      </p>
      {message ? <p className="jobs-dashboard__status">{message}</p> : null}
      {canTrigger ? (
        <form className="jobs-dashboard__form" onSubmit={trigger}>
          <label>
            Job
            <select onChange={(event) => setJobName(event.target.value)} value={jobName}>
              {jobNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Payload JSON
            <textarea onChange={(event) => setPayloadText(event.target.value)} rows={4} value={payloadText} />
          </label>
          <button disabled={pending || !jobName} type="submit">
            Trigger job
          </button>
        </form>
      ) : (
        <p>You can view jobs. Triggering a job requires the trigger permission.</p>
      )}
      <div className="jobs-dashboard__filters">
        <label>
          Status
          <select
            onChange={(event) => setStatusFilter(event.target.value)}
            value={statusFilter}
          >
            {['ALL', 'PENDING', 'RUNNING', 'SUCCESS', 'FAILED'].map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <button disabled={pending} onClick={() => void refresh().catch((error: Error) => setMessage(error.message))} type="button">
          Refresh
        </button>
      </div>
      <div className="jobs-dashboard__table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Status</th>
              <th>Attempt</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6}>No jobs in this view.</td>
              </tr>
            ) : (
              visible.map((row) => (
                <React.Fragment key={row.id}>
                  <tr>
                    <td>{row.id}</td>
                    <td>{row.name}</td>
                    <td>{row.status}</td>
                    <td>
                      {row.attempt}/{row.maxAttempts}
                    </td>
                    <td>{row.updatedAt ?? row.createdAt}</td>
                    <td>
                      <button onClick={() => setOpenId(openId === row.id ? null : row.id)} type="button">
                        {openId === row.id ? 'Hide' : 'Logs'}
                      </button>
                      {canRetry && row.status === 'FAILED' ? (
                        <button disabled={pending} onClick={() => void retry(row.id)} type="button">
                          Retry
                        </button>
                      ) : null}
                    </td>
                  </tr>
                  {openId === row.id ? (
                    <tr>
                      <td colSpan={6}>
                        <pre>{JSON.stringify({ payload: row.payload, error: row.error, logs: row.logs }, null, 2)}</pre>
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch((): null => null)) as {
    errors?: Array<{ message?: string }>
    error?: string
  } | null
  return body?.errors?.[0]?.message || body?.error || `Request failed (${response.status}).`
}
