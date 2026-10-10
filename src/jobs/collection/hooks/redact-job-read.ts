import type { CollectionAfterReadHook } from 'payload'

import { capLogs, capText } from '../../redaction/cap-stored-text'
import { redactSensitive } from '../../redaction/redact-sensitive'
import { MAX_ERROR_CHARS } from '../../constants'
import type { JobLogEntry } from '../../types'

export const redactJobRead: CollectionAfterReadHook = ({ doc }) => {
  const next = { ...doc }
  next.payload = redactSensitive(next.payload)
  if (typeof next.error === 'string') {
    next.error = capText(next.error, MAX_ERROR_CHARS)
  }
  if (Array.isArray(next.logs)) {
    next.logs = capLogs(next.logs as JobLogEntry[])
  }
  delete next.claimToken
  return next
}
