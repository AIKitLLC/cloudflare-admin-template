import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
} from 'payload'

import { buildSystemParameterAudit, rememberSystemParameterAudit } from '../sensitive/audit-view'
import type { ParameterWriteData } from '../types'

type AuditDoc = ParameterWriteData & { id?: number | string }

export const previewSystemParameterAudit: CollectionBeforeChangeHook = ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (operation !== 'update' || originalDoc?.id == null) {
    return data
  }
  const previous = originalDoc as AuditDoc
  const next: AuditDoc = {
    ...previous,
    ...(data as ParameterWriteData),
    id: previous.id,
  }
  rememberSystemParameterAudit(
    req.context,
    buildSystemParameterAudit({
      operation: 'update',
      previous,
      next,
    }),
  )
  return data
}

export const recordSystemParameterAudit: CollectionAfterChangeHook = ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  const next = doc as AuditDoc
  const previous = previousDoc as AuditDoc | undefined
  rememberSystemParameterAudit(
    req.context,
    buildSystemParameterAudit({
      operation,
      previous: previous ?? null,
      next,
    }),
  )
  return doc
}

export const recordSystemParameterDeletion: CollectionAfterDeleteHook = ({ doc, req }) => {
  const deleted = doc as AuditDoc
  rememberSystemParameterAudit(
    req.context,
    buildSystemParameterAudit({
      operation: 'delete',
      previous: deleted,
      next: null,
    }),
  )
}
