import { randomUUID } from 'crypto'
import type { Payload, PayloadRequest } from 'payload'

import { JOBS_SLUG, JOB_TRIGGER_WRITE, MAX_PAYLOAD_CHARS } from '../constants'
import {
  INVALID_PAYLOAD_MESSAGE,
  PAYLOAD_TOO_LARGE_MESSAGE,
  TRIGGER_FORBIDDEN_MESSAGE,
  UNKNOWN_JOB_MESSAGE,
  jobError,
} from '../errors'
import { getJob } from '../registry/job-registry'
import { isWellFormedJobName } from '../validation/job-name'
import type { StoredJob } from '../types'
import { evaluateJobDispatch } from '../auth/evaluate-job-dispatch'

export type EnqueueResult = {
  created: boolean
  job: StoredJob
}

export async function enqueueRegisteredJob(args: {
  idempotencyKey?: string | null
  name: unknown
  payload: unknown
  req: PayloadRequest
}): Promise<EnqueueResult> {
  if (!(await evaluateJobDispatch(args.req, 'trigger'))) {
    throw jobError(TRIGGER_FORBIDDEN_MESSAGE, 403)
  }
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!isWellFormedJobName(name) || !getJob(name)) {
    throw jobError(UNKNOWN_JOB_MESSAGE)
  }
  assertPayloadSize(args.payload)
  const idempotencyKey = normalizeKey(args.idempotencyKey)
  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(args.req.payload, idempotencyKey)
    if (existing) {
      return { created: false, job: existing }
    }
  }
  try {
    const job = await args.req.payload.create({
      collection: JOBS_SLUG,
      data: {
        name,
        payload: (args.payload ?? {}) as Record<string, unknown>,
        idempotencyKey: idempotencyKey ?? randomUUID(),
        status: 'PENDING',
        attempt: 0,
        maxAttempts: 5,
      },
      overrideAccess: true,
      draft: false,
      req: args.req,
      context: {
        [JOB_TRIGGER_WRITE]: true,
      },
    })
    return { created: true, job: job as StoredJob }
  } catch (error) {
    if (idempotencyKey && isUniqueConstraintError(error)) {
      const existing = await findByIdempotencyKey(args.req.payload, idempotencyKey)
      if (existing) {
        return { created: false, job: existing }
      }
    }
    throw error
  }
}

function assertPayloadSize(value: unknown): void {
  let serialized = ''
  try {
    serialized = JSON.stringify(value ?? {})
  } catch {
    throw jobError(INVALID_PAYLOAD_MESSAGE)
  }
  if (serialized.length > MAX_PAYLOAD_CHARS) {
    throw jobError(PAYLOAD_TOO_LARGE_MESSAGE)
  }
}

function normalizeKey(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  if (trimmed.length > 200) {
    throw jobError('Idempotency key is too long.')
  }
  return trimmed
}

async function findByIdempotencyKey(payload: Payload, key: string): Promise<StoredJob | null> {
  const found = await payload.find({
    collection: JOBS_SLUG,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { idempotencyKey: { equals: key } },
  })
  return (found.docs[0] as StoredJob | undefined) ?? null
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unique constraint failed/i.test(message) || /already exists/i.test(message)
}
