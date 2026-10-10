import { APIError, type CollectionBeforeChangeHook, type CollectionBeforeDeleteHook } from 'payload'

export const rejectAuditLogUpdate: CollectionBeforeChangeHook = ({ data, operation }) => {
  if (operation === 'update') {
    throw new APIError('Audit logs are append-only and cannot be updated.', 403, null, true)
  }
  return data
}

export const rejectAuditLogDelete: CollectionBeforeDeleteHook = () => {
  throw new APIError('Audit logs are append-only and cannot be deleted.', 403, null, true)
}
