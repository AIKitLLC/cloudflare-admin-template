import {
  REDACTED_PARAMETER_VALUE,
  SYSTEM_PARAMETER_AUDIT_CONTEXT,
  SYSTEM_PARAMETERS_SLUG,
} from '../constants'
import type {
  ParameterWriteData,
  SystemParameterAuditRecord,
  SystemParameterAuditView,
} from '../types'
import { isParameterValueType } from '../validation/typed-value'

type AuditDoc = ParameterWriteData & { id?: number | string }

export function toSystemParameterAuditView(
  doc: AuditDoc,
  redact: boolean,
): SystemParameterAuditView {
  return {
    id: doc.id ?? 0,
    key: typeof doc.key === 'string' ? doc.key : '',
    category: typeof doc.category === 'string' ? doc.category : '',
    valueType: isParameterValueType(doc.valueType) ? doc.valueType : null,
    sensitive: Boolean(doc.sensitive),
    value: redact ? REDACTED_PARAMETER_VALUE : valueForAudit(doc.value),
  }
}

export function buildSystemParameterAudit(args: {
  operation: SystemParameterAuditRecord['operation']
  previous?: AuditDoc | null
  next?: AuditDoc | null
}): SystemParameterAuditRecord {
  const redact = Boolean(args.previous?.sensitive) || Boolean(args.next?.sensitive)
  return {
    collection: SYSTEM_PARAMETERS_SLUG,
    operation: args.operation,
    previous: args.previous ? toSystemParameterAuditView(args.previous, redact) : null,
    next: args.next ? toSystemParameterAuditView(args.next, redact) : null,
  }
}

export function redactSystemParameterHookArguments(args: {
  data?: ParameterWriteData | null
  doc?: ParameterWriteData | null
  previousDoc?: ParameterWriteData | null
}): void {
  const redact =
    Boolean(args.data?.sensitive) ||
    Boolean(args.doc?.sensitive) ||
    Boolean(args.previousDoc?.sensitive)
  if (!redact) {
    return
  }
  if (args.previousDoc) {
    args.previousDoc.value = REDACTED_PARAMETER_VALUE
  }
  if (args.data) {
    args.data.value = REDACTED_PARAMETER_VALUE
  }
  if (args.doc && containsPlainValue(args.doc.value)) {
    args.doc.value = null
  }
}

export function readSystemParameterAudit(context: unknown): SystemParameterAuditRecord | null {
  if (!context || typeof context !== 'object') {
    return null
  }
  const record = (context as Record<string, unknown>)[SYSTEM_PARAMETER_AUDIT_CONTEXT]
  if (!record || typeof record !== 'object') {
    return null
  }
  return record as SystemParameterAuditRecord
}

function valueForAudit(value: unknown): SystemParameterAuditView['value'] {
  if (value === null || value === undefined) {
    return null
  }
  return value as SystemParameterAuditView['value']
}

function containsPlainValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false
  }
  if (value === REDACTED_PARAMETER_VALUE) {
    return false
  }
  return true
}
