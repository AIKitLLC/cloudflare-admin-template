import type { CollectionBeforeChangeHook } from 'payload'

import {
  DEFAULT_MAX_ATTEMPTS,
  JOB_RETRY_WRITE,
  JOB_SYSTEM_WRITE,
  JOB_TRIGGER_WRITE,
  MAX_PAYLOAD_CHARS,
} from '../../constants'
import {
  INVALID_PAYLOAD_MESSAGE,
  PAYLOAD_TOO_LARGE_MESSAGE,
  RETRY_ONLY_FAILED_MESSAGE,
  UNKNOWN_JOB_MESSAGE,
  jobError,
} from '../../errors'
import { getJob } from '../../registry/job-registry'
import { capLogs, capText } from '../../redaction/cap-stored-text'
import { redactSensitive } from '../../redaction/redact-sensitive'
import { isWellFormedJobName } from '../../validation/job-name'
import { MAX_ERROR_CHARS } from '../../constants'
import type { JobLogEntry, StoredJob } from '../../types'

export const prepareJobWrite: CollectionBeforeChangeHook = ({ data, operation, originalDoc, req }) => {
  if (req.context?.[JOB_SYSTEM_WRITE] === true) {
    return redactRecord(data)
  }
  if (req.context?.[JOB_RETRY_WRITE] === true) {
    return normalizeRetry(data, originalDoc as StoredJob | undefined)
  }
  if (operation === 'create' || req.context?.[JOB_TRIGGER_WRITE] === true) {
    return normalizeCreate(data)
  }
  throw jobError('Jobs cannot be edited.')
}

function normalizeCreate(data: Record<string, unknown>): Record<string, unknown> {
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
  const redacted = redactSensitive(validated)
  assertStoredSize(redacted)
  return {
    name,
    payload: redacted,
    status: 'PENDING',
    error: null,
    logs: [],
    attempt: 0,
    maxAttempts: definition.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    runAt: null,
    leaseExpiresAt: null,
    startedAt: null,
    finishedAt: null,
    idempotencyKey: data.idempotencyKey,
    claimToken: null,
  }
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
  if ('payload' in next) {
    next.payload = redactSensitive(next.payload)
  }
  if (typeof next.error === 'string') {
    next.error = capText(next.error, MAX_ERROR_CHARS)
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
