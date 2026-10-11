import { randomUUID } from 'crypto'
import type { Payload, PayloadRequest } from 'payload'

import { DEFAULT_MAX_ATTEMPTS, JOBS_SLUG, JOB_TRIGGER_WRITE, MAX_PAYLOAD_CHARS } from '../constants'
import {
  IDEMPOTENCY_CONFLICT_MESSAGE,
  INVALID_PAYLOAD_MESSAGE,
  JOB_PRIVILEGE_MESSAGE,
  PAYLOAD_HAS_SECRET_MESSAGE,
  PAYLOAD_TOO_LARGE_MESSAGE,
  TRIGGER_FORBIDDEN_MESSAGE,
  UNKNOWN_JOB_MESSAGE,
  jobError,
} from '../errors'
import { getJob } from '../registry/job-registry'
import { findSecretKey } from '../redaction/secret-key'
import { isWellFormedJobName } from '../validation/job-name'
import type { StoredJob } from '../types'
import { evaluateJobDispatch } from '../auth/evaluate-job-dispatch'
import { evaluateJobTrigger } from '../auth/evaluate-job-trigger'
import { isScopedIdempotencyKey, sameJobPayload, scopeIdempotencyKey } from './idempotency-key'

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
  if (!(await evaluateJobTrigger(args.req, name))) {
    throw jobError(JOB_PRIVILEGE_MESSAGE, 403)
  }
  const definition = getJob(name)
  if (!definition) {
    throw jobError(UNKNOWN_JOB_MESSAGE)
  }
  let validated: unknown
  try {
    validated = definition.validate(args.payload ?? {})
  } catch (error) {
    const message = error instanceof Error ? error.message : INVALID_PAYLOAD_MESSAGE
    throw jobError(message || INVALID_PAYLOAD_MESSAGE)
  }
  if (findSecretKey(args.payload) || findSecretKey(validated)) {
    throw jobError(PAYLOAD_HAS_SECRET_MESSAGE)
  }
  assertPayloadSize(validated)
  const idempotencyKey = scopedKey(args.req.user?.id ?? 'anonymous', name, args.idempotencyKey)
  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(args.req.payload, idempotencyKey)
    if (existing) {
      if (existing.name !== name || !sameJobPayload(existing.payload, validated)) {
        throw jobError(IDEMPOTENCY_CONFLICT_MESSAGE)
      }
      return { created: false, job: existing }
    }
  }
  try {
    const job = await args.req.payload.create({
      collection: JOBS_SLUG,
      data: {
        name,
        payload: validated as Record<string, unknown>,
        idempotencyKey: idempotencyKey ?? randomUUID(),
        status: 'PENDING',
        attempt: 0,
        maxAttempts: definition.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
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

function scopedKey(
  userId: number | string,
  jobName: string,
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  if (trimmed.length > 120) {
    throw jobError('Idempotency key is too long.')
  }
  if (isScopedIdempotencyKey(trimmed)) {
    return trimmed
  }
  return scopeIdempotencyKey(userId, jobName, trimmed)
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
