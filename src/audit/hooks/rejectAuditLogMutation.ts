import { APIError, type CollectionBeforeChangeHook, type CollectionBeforeDeleteHook, type PayloadRequest } from 'payload'

import { AUDIT_LOG_INTERNAL_WRITE } from '../constants'

export const rejectAuditLogUpdate: CollectionBeforeChangeHook = ({ data, operation, req }) => {
  if (operation === 'update' && !isInternalAuditWrite(req)) {
    throw new APIError('Audit logs are append-only and cannot be updated.', 403, null, true)
  }
  return data
}

export const rejectAuditLogDelete: CollectionBeforeDeleteHook = ({ req }) => {
  if (!isInternalAuditWrite(req)) {
    throw new APIError('Audit logs are append-only and cannot be deleted.', 403, null, true)
  }
}

function isInternalAuditWrite(req: PayloadRequest): boolean {
  return req.context?.[AUDIT_LOG_INTERNAL_WRITE] === true
}
