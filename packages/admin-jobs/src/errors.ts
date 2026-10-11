import { APIError } from 'payload'

export const UNKNOWN_JOB_MESSAGE = 'Unknown job name.'
export const INVALID_PAYLOAD_MESSAGE = 'Job payload is invalid.'
export const PAYLOAD_TOO_LARGE_MESSAGE = 'Job payload is too large.'
export const PAYLOAD_HAS_SECRET_MESSAGE = 'Payload keys that look like secrets are not allowed.'
export const IDEMPOTENCY_CONFLICT_MESSAGE = 'Idempotency key was already used with a different payload.'
export const JOB_PRIVILEGE_MESSAGE = 'You are not allowed to trigger this job.'
export const RETRY_ONLY_FAILED_MESSAGE = 'Only failed jobs can be retried.'
export const TRIGGER_FORBIDDEN_MESSAGE = 'You are not allowed to trigger jobs.'
export const RETRY_FORBIDDEN_MESSAGE = 'You are not allowed to retry jobs.'
export const JOB_NOT_FOUND_MESSAGE = 'Job not found.'
export const JOB_QUERY_TOO_WIDE_MESSAGE = 'Job query is too wide.'

export function jobError(message: string, status = 400): APIError {
  return new APIError(message, status)
}
