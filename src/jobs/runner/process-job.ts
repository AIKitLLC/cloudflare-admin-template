import type { Payload } from 'payload'

import { BACKOFF_BASE_MS } from '../constants'
import { backoffMs } from '../delivery/backoff'
import { deliverJob } from '../delivery/deliver-job'
import { errorDetails } from '../redaction/cap-stored-text'
import { capLogs } from '../redaction/cap-stored-text'
import { UNKNOWN_JOB_MESSAGE } from '../errors'
import { getJob } from '../registry/job-registry'
import type { JobLogEntry } from '../types'
import { extendLease } from '../persistence/extend-lease'
import { finishJob } from '../persistence/finish-job'
import { claimJob } from '../persistence/claim-job'
import { readStoredJob } from '../persistence/read-stored-job'

export type ProcessResult = {
  outcome: 'failed' | 'retried' | 'skipped' | 'succeeded'
}

export async function processJob(
  payload: Payload,
  jobId: number | string,
  now = new Date(),
): Promise<ProcessResult> {
  const current = await readStoredJob(payload, jobId)
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
  const logs: JobLogEntry[] = [...(current.logs ?? [])]
  try {
    const validated = definition.validate(current.payload ?? {})
    await definition.execute({
      attempt: claim.attempt,
      heartbeat: () => extendLease(payload, jobId, claim.claimToken),
      idempotencyKey: current.idempotencyKey,
      jobId,
      log: (message) => {
        logs.push({ at: new Date().toISOString(), message })
      },
      payload: validated,
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
    const exhausted = claim.attempt >= (definition.maxAttempts ?? current.maxAttempts)
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
    if (finished && !exhausted) {
      await deliverJob(payload, jobId, { delayMs: delay })
      return { outcome: 'retried' }
    }
    return { outcome: finished ? 'failed' : 'skipped' }
  }
}
