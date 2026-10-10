import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, PayloadRequest } from 'payload'

import { SYSTEM_PARAMETER_AUDIT_CONTEXT } from '../constants'
import {
  buildSystemParameterAudit,
  redactSystemParameterHookArguments,
} from '../sensitive/audit-view'
import type { ParameterWriteData, SystemParameterAuditRecord } from '../types'

export const recordSystemParameterAudit: CollectionAfterChangeHook = ({
  data,
  doc,
  operation,
  previousDoc,
  req,
}) => {
  const next = doc as ParameterWriteData & { id?: number | string }
  const previous = previousDoc as (ParameterWriteData & { id?: number | string }) | undefined
  const write = data as ParameterWriteData
  publishAudit(req, {
    operation,
    previous,
    next,
  })
  redactSystemParameterHookArguments({
    data: write,
    doc: next,
    previousDoc: previous,
  })
  return doc
}

export const recordSystemParameterDeletion: CollectionAfterDeleteHook = ({ doc, req }) => {
  const deleted = doc as ParameterWriteData & { id?: number | string }
  publishAudit(req, {
    operation: 'delete',
    previous: deleted,
    next: null,
  })
  redactSystemParameterHookArguments({
    doc: deleted,
    previousDoc: deleted,
  })
}

function publishAudit(
  req: PayloadRequest,
  args: {
    operation: SystemParameterAuditRecord['operation']
    previous?: (ParameterWriteData & { id?: number | string }) | null
    next?: (ParameterWriteData & { id?: number | string }) | null
  },
): void {
  req.context[SYSTEM_PARAMETER_AUDIT_CONTEXT] = buildSystemParameterAudit(args)
}
