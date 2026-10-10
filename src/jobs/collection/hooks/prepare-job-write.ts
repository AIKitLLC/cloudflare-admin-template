import type { CollectionBeforeChangeHook, PayloadRequest } from 'payload'

import {
  DEFAULT_MAX_ATTEMPTS,
  JOB_RETRY_WRITE,
  JOB_SYSTEM_WRITE,
  JOB_TRIGGER_WRITE,
  MAX_PAYLOAD_CHARS,
} from '../../constants'
import {
  INVALID_PAYLOAD_MESSAGE,
  JOB_PRIVILEGE_MESSAGE,
  PAYLOAD_HAS_SECRET_MESSAGE,
  PAYLOAD_TOO_LARGE_MESSAGE,
  RETRY_ONLY_FAILED_MESSAGE,
  UNKNOWN_JOB_MESSAGE,
  jobError,
} from '../../errors'
import { getJob } from '../../registry/job-registry'
import { capLogs, capText } from '../../redaction/cap-stored-text'
import { redactText } from '../../redaction/redact-sensitive'
import { findSecretKey } from '../../redaction/secret-key'
import { isWellFormedJobName } from '../../validation/job-name'
import { MAX_ERROR_CHARS } from '../../constants'
import type { JobLogEntry, StoredJob } from '../../types'
import { evaluateJobTrigger } from '../../auth/evaluate-job-trigger'
import { isScopedIdempotencyKey, scopeIdempotencyKey } from '../../delivery/idempotency-key'

export const prepareJobWrite: CollectionBeforeChangeHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (req.context?.[JOB_SYSTEM_WRITE] === true) {
    return redactRecord(data)
  }
  if (req.context?.[JOB_RETRY_WRITE] === true) {
    return normalizeRetry(data, originalDoc as StoredJob | undefined)
  }
  if (operation === 'create' || req.context?.[JOB_TRIGGER_WRITE] === true) {
    return normalizeCreate(data, req)
  }
  throw jobError('Jobs cannot be edited.')
}

async function normalizeCreate(
  data: Record<string, unknown>,
  req: PayloadRequest,
): Promise<Record<string, unknown>> {
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  if (!isWellFormedJobName(name)) {
    throw jobError(UNKNOWN_JOB_MESSAGE)
  }
  const definition = getJob(name)
  if (!definition) {
    throw jobError(UNKNOWN_JOB_MESSAGE)
  }
  let validated: unknown
  try {
    validated = definition.validate(data.payload ?? {})
  } catch (error) {
    const message = error instanceof Error ? error.message : INVALID_PAYLOAD_MESSAGE
    throw jobError(message || INVALID_PAYLOAD_MESSAGE)
  }
  if (findSecretKey(data.payload) || findSecretKey(validated)) {
    throw jobError(PAYLOAD_HAS_SECRET_MESSAGE)
  }
  if (!(await evaluateJobTrigger(req, name))) {
    throw jobError(JOB_PRIVILEGE_MESSAGE, 403)
  }
  assertStoredSize(validated)
  return {
    name,
    payload: validated,
    status: 'PENDING',
    error: null,
    logs: [],
    attempt: 0,
    maxAttempts: definition.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    runAt: null,
    leaseExpiresAt: null,
    startedAt: null,
    finishedAt: null,
    idempotencyKey: scopeStoredKey(req, name, data.idempotencyKey),
    claimToken: null,
  }
}

function scopeStoredKey(req: PayloadRequest, jobName: string, value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) {
    return value
  }
  if (isScopedIdempotencyKey(value)) {
    return value
  }
  return scopeIdempotencyKey(req.user?.id ?? 'anonymous', jobName, value.trim())
}

function normalizeRetry(
  data: Record<string, unknown>,
  originalDoc: StoredJob | undefined,
): Record<string, unknown> {
  if (!originalDoc || originalDoc.status !== 'FAILED') {
    throw jobError(RETRY_ONLY_FAILED_MESSAGE)
  }
  return {
    ...data,
    name: originalDoc.name,
    payload: originalDoc.payload,
    status: 'PENDING',
    attempt: 0,
    maxAttempts: originalDoc.maxAttempts,
    runAt: null,
    leaseExpiresAt: null,
    startedAt: null,
    finishedAt: null,
    claimToken: null,
    idempotencyKey: originalDoc.idempotencyKey,
    logs: originalDoc.logs ?? [],
    error: originalDoc.error ?? null,
  }
}

function redactRecord(data: Record<string, unknown>): Record<string, unknown> {
  const next = { ...data }
  if (typeof next.error === 'string') {
    next.error = capText(redactText(next.error), MAX_ERROR_CHARS)
  }
  if (Array.isArray(next.logs)) {
    next.logs = capLogs(next.logs as JobLogEntry[])
  }
  return next
}

function assertStoredSize(value: unknown): void {
  if (JSON.stringify(value ?? {}).length > MAX_PAYLOAD_CHARS) {
    throw jobError(PAYLOAD_TOO_LARGE_MESSAGE)
  }
}
