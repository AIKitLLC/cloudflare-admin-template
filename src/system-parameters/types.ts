import type { PARAMETER_VALUE_TYPES } from './constants'
import type { REDACTED_PARAMETER_VALUE } from './constants'

export type ParameterValueType = (typeof PARAMETER_VALUE_TYPES)[number]

export type JsonObject = { [key: string]: JsonValue }
export type JsonArray = JsonValue[]
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray

export type ParameterValue = string | number | boolean | JsonObject | JsonArray

export type ParameterSnapshot = {
  key: string
  valueType: ParameterValueType
  value: ParameterValue
  sensitive: boolean
}

export type ParameterWriteData = {
  key?: unknown
  category?: unknown
  valueType?: unknown
  value?: unknown
  sensitive?: unknown
}

export type SystemParameterAuditView = {
  id: number | string
  key: string
  category: string
  valueType: ParameterValueType | null
  sensitive: boolean
  value: ParameterValue | typeof REDACTED_PARAMETER_VALUE | null
}

export type SystemParameterAuditRecord = {
  collection: 'system-parameters'
  operation: 'create' | 'update' | 'delete'
  previous: SystemParameterAuditView | null
  next: SystemParameterAuditView | null
}

/** Redacted audit rows keyed by document id. Bulk writes each get their own entry. */
export type SystemParameterAuditMap = Record<string, SystemParameterAuditRecord>

export type VersionStore = {
  readVersion: () => Promise<number>
  bumpVersion: () => Promise<number>
}

export type ParameterKv = {
  get: (key: string) => Promise<string | null>
  put: (key: string, value: string) => Promise<void>
  delete: (key: string) => Promise<void>
}
