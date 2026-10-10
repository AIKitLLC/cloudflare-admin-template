export type AuditLogViewerFilters = {
  recordId: string
  collection: string
  operator: string
}

const RECORD_ID_PARAM = 'where[documentId][equals]'
const COLLECTION_PARAM = 'where[collectionSlug][equals]'
const OPERATOR_EMAIL_PARAM = 'where[actorEmail][contains]'
const OPERATOR_ID_PARAM = 'where[operatorId][equals]'

export function readAuditLogViewerFilters(current: URLSearchParams): AuditLogViewerFilters {
  return {
    recordId: current.get(RECORD_ID_PARAM) ?? '',
    collection: current.get(COLLECTION_PARAM) ?? '',
    operator: current.get(OPERATOR_EMAIL_PARAM) ?? current.get(OPERATOR_ID_PARAM) ?? '',
  }
}

/**
 * Builds the admin list query for the audit viewer.
 * Numeric operators match the operator id. Anything else matches the operator email.
 * Existing `where` clauses are replaced so the bar is the source of truth.
 */
export function applyAuditLogViewerFilters(
  current: URLSearchParams,
  filters: AuditLogViewerFilters,
): URLSearchParams {
  const next = new URLSearchParams()
  for (const [key, value] of current.entries()) {
    if (key === 'page' || key.startsWith('where')) continue
    next.append(key, value)
  }

  const recordId = filters.recordId.trim()
  const collection = filters.collection.trim()
  const operator = filters.operator.trim()

  if (recordId) next.set(RECORD_ID_PARAM, recordId)
  if (collection) next.set(COLLECTION_PARAM, collection)
  if (operator) {
    if (/^\d+$/.test(operator)) next.set(OPERATOR_ID_PARAM, operator)
    else next.set(OPERATOR_EMAIL_PARAM, operator)
  }

  return next
}
