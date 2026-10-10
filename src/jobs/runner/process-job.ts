import type { Payload } from 'payload'

import { BACKOFF_BASE_MS, DEFAULT_LEASE_MS, DEFAULT_MAX_ATTEMPTS } from '../constants'
import { backoffMs } from '../delivery/backoff'
import { deliverJob } from '../delivery/deliver-job'
import { UNKNOWN_JOB_MESSAGE } from '../errors'
import { capLogs, errorDetails } from '../redaction/cap-stored-text'
import { getJob } from '../registry/job-registry'
import type { JobLogEntry } from '../types'
import { claimJob } from '../persistence/claim-job'
import { extendLease } from '../persistence/extend-lease'
import { finishJob } from '../persistence/finish-job'
import { readStoredJob } from '../persistence/read-stored-job'

export type ProcessResult = {
  outcome: 'failed' | 'retried' | 'skipped' | 'succeeded'
}

export async function processJob(
  payload: Payload,
  jobId: number | string,
  now = new Date(),
): Promise<ProcessResult> {
  const current = await readStoredJob(payload, jobId, { raw: true })
  if (!current) {
    return { outcome: 'skipped' }
  }
  if (current.status === 'SUCCESS' || current.status === 'FAILED') {
    return { outcome: 'skipped' }
  }
  if (current.runAt && current.status === 'PENDING' && current.runAt > now.toISOString()) {
    return { outcome: 'skipped' }
  }
  const claim = await claimJob(payload, jobId, now)
  if (!claim) {
    return { outcome: 'skipped' }
  }
  const definition = getJob(current.name)
  const maxAttempts = current.maxAttempts || DEFAULT_MAX_ATTEMPTS
  if (!definition) {
    await finishJob(payload, {
      claimToken: claim.claimToken,
      error: errorDetails(new Error(UNKNOWN_JOB_MESSAGE)),
      jobId,
      logs: current.logs ?? [],
      now,
      status: 'FAILED',
    })
    return { outcome: 'failed' }
  }
  const leaseMs = definition.leaseMs ?? DEFAULT_LEASE_MS
  const renewal = startLeaseRenewal(payload, jobId, claim.claimToken, leaseMs)
  const logs: JobLogEntry[] = [...(current.logs ?? [])]
  try {
    const validated = definition.validate(current.payload ?? {})
    await definition.execute({
      attempt: claim.attempt,
      heartbeat: () => extendLease(payload, jobId, claim.claimToken, leaseMs),
      idempotencyKey: current.idempotencyKey,
      jobId,
      log: (message) => {
        logs.push({ at: new Date().toISOString(), message })
      },
      payload: validated,
      signal: renewal.signal,
    })
    const finished = await finishJob(payload, {
      claimToken: claim.claimToken,
      error: null,
      jobId,
      logs: capLogs(logs),
      now,
      status: 'SUCCESS',
    })
    return { outcome: finished ? 'succeeded' : 'skipped' }
  } catch (error) {
    const message = errorDetails(error)
    const exhausted = claim.attempt >= maxAttempts
    const delay = backoffMs(claim.attempt, definition.backoffBaseMs ?? BACKOFF_BASE_MS)
    const finished = await finishJob(payload, {
      claimToken: claim.claimToken,
      error: message,
      jobId,
      logs: capLogs(logs),
      now,
      runAt: exhausted ? null : new Date(now.getTime() + delay).toISOString(),
      status: exhausted ? 'FAILED' : 'PENDING',
    })
    if (!finished) {
      return { outcome: 'skipped' }
    }
    if (!exhausted) {
      await deliverJob(payload, jobId, { delayMs: delay })
      return { outcome: 'retried' }
    }
    return { outcome: 'failed' }
  } finally {
    renewal.stop()
  }
}

function startLeaseRenewal(
  payload: Payload,
  jobId: number | string,
  claimToken: string,
  leaseMs: number,
): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController()
  const intervalMs = Math.max(250, Math.floor(leaseMs / 3))
  let stopped = false
  const timer = setInterval(() => {
    if (stopped || controller.signal.aborted) {
      return
    }
    void extendLease(payload, jobId, claimToken, leaseMs)
      .then((extended) => {
        if (!extended && !stopped) {
          controller.abort()
        }
      })
      .catch(() => {
        if (!stopped) {
          controller.abort()
        }
      })
  }, intervalMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
