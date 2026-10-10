import { SYSTEM_PARAMETER_AUDIT_CONTEXT, SYSTEM_PARAMETERS_SLUG } from '../constants'
import type {
  ParameterWriteData,
  SystemParameterAuditMap,
  SystemParameterAuditRecord,
  SystemParameterAuditView,
} from '../types'
import { REDACTED_PARAMETER_VALUE } from '../constants'
import { isParameterValueType } from '../validation/typed-value'

type AuditDoc = ParameterWriteData & { id?: number | string }

export function redactSystemParameterForAudit<T extends ParameterWriteData>(doc: T): T {
  if (!doc.sensitive) {
    return { ...doc }
  }
  return {
    ...doc,
    value: REDACTED_PARAMETER_VALUE,
  }
}

export function toSystemParameterAuditView(doc: AuditDoc): SystemParameterAuditView {
  const redacted = redactSystemParameterForAudit(doc)
  return {
    id: redacted.id ?? 0,
    key: typeof redacted.key === 'string' ? redacted.key : '',
    category: typeof redacted.category === 'string' ? redacted.category : '',
    valueType: isParameterValueType(redacted.valueType) ? redacted.valueType : null,
    sensitive: Boolean(redacted.sensitive),
    value: redacted.sensitive ? REDACTED_PARAMETER_VALUE : valueForAudit(redacted.value),
  }
}

export function buildSystemParameterAudit(args: {
  operation: SystemParameterAuditRecord['operation']
  previous?: AuditDoc | null
  next?: AuditDoc | null
}): SystemParameterAuditRecord {
  return {
    collection: SYSTEM_PARAMETERS_SLUG,
    operation: args.operation,
    previous: args.previous ? toSystemParameterAuditView(args.previous) : null,
    next: args.next ? toSystemParameterAuditView(args.next) : null,
  }
}

export function rememberSystemParameterAudit(
  context: object,
  record: SystemParameterAuditRecord,
): void {
  const id = record.next?.id ?? record.previous?.id
  if (id === undefined || id === null || id === '') {
    return
  }
  const store = context as Record<string, unknown>
  const current = store[SYSTEM_PARAMETER_AUDIT_CONTEXT]
  const map = isAuditMap(current) ? current : {}
  if (map !== current) {
    store[SYSTEM_PARAMETER_AUDIT_CONTEXT] = map
  }
  map[String(id)] = record
}

export function readSystemParameterAudits(context: unknown): SystemParameterAuditMap {
  if (!context || typeof context !== 'object') {
    return {}
  }
  const current = (context as Record<string, unknown>)[SYSTEM_PARAMETER_AUDIT_CONTEXT]
  if (!isAuditMap(current)) {
    return {}
  }
  return { ...current }
}

export function readSystemParameterAudit(
  context: unknown,
  id: number | string,
): SystemParameterAuditRecord | null {
  return readSystemParameterAudits(context)[String(id)] ?? null
}

function valueForAudit(value: unknown): SystemParameterAuditView['value'] {
  if (value === null || value === undefined) {
    return null
  }
  return value as SystemParameterAuditView['value']
}

function isAuditMap(value: unknown): value is SystemParameterAuditMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  if ('operation' in value && 'collection' in value) {
    return false
  }
  return true
}
