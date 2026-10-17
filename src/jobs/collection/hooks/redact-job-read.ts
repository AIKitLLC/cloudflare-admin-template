import type { CollectionAfterReadHook } from 'payload'

import { JOB_HANDLER_READ, MAX_ERROR_CHARS } from '../../constants'
import { capLogs, capText } from '../../redaction/cap-stored-text'
import { redactSensitive, redactText } from '../../redaction/redact-sensitive'
import type { JobLogEntry } from '../../types'

export const redactJobRead: CollectionAfterReadHook = ({ doc, req }) => {
  const next = { ...doc }
  delete next.claimToken
  if (req?.context?.[JOB_HANDLER_READ] === true) {
    return next
  }
  next.payload = redactSensitive(next.payload)
  if (typeof next.error === 'string') {
    next.error = capText(redactText(next.error), MAX_ERROR_CHARS)
  }
  if (Array.isArray(next.logs)) {
    next.logs = capLogs(next.logs as JobLogEntry[])
  }
  return next
}
