import { MAX_JSON_CHARS, MAX_JSON_DEPTH, MAX_STRING_VALUE_LENGTH } from '../constants'
import type { JsonArray, JsonObject, ParameterValue, ParameterValueType } from '../types'
import { PARAMETER_VALUE_TYPES } from '../constants'
import {
  PARAMETER_BOOLEAN_VALUE_ERROR,
  PARAMETER_JSON_DEPTH_ERROR,
  PARAMETER_JSON_SHAPE_ERROR,
  PARAMETER_JSON_SIZE_ERROR,
  PARAMETER_JSON_SYNTAX_ERROR,
  PARAMETER_NUMBER_VALUE_ERROR,
  PARAMETER_STRING_LENGTH_ERROR,
  PARAMETER_STRING_VALUE_ERROR,
  PARAMETER_VALUE_REQUIRED_ERROR,
  PARAMETER_VALUE_TYPE_ERROR,
} from './messages'

export function isParameterValueType(value: unknown): value is ParameterValueType {
  return typeof value === 'string' && (PARAMETER_VALUE_TYPES as readonly string[]).includes(value)
}

export function validateTypedParameterValue(args: {
  value: unknown
  valueType: unknown
  jsonError?: unknown
}): string | true {
  if (args.jsonError && args.valueType === 'json') {
    return PARAMETER_JSON_SYNTAX_ERROR
  }
  if (args.value === undefined || args.value === null) {
    return PARAMETER_VALUE_REQUIRED_ERROR
  }
  if (!isParameterValueType(args.valueType)) {
    return PARAMETER_VALUE_TYPE_ERROR
  }
  return valueMatchesType(args.valueType, args.value)
}

export function valueMatchesType(valueType: ParameterValueType, value: unknown): string | true {
  if (valueType === 'string') {
    return stringValueError(value)
  }
  if (valueType === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? true : PARAMETER_NUMBER_VALUE_ERROR
  }
  if (valueType === 'boolean') {
    return typeof value === 'boolean' ? true : PARAMETER_BOOLEAN_VALUE_ERROR
  }
  return jsonContainerError(value)
}

export function parseJsonParameterString(input: string): JsonObject | JsonArray {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    throw new Error(PARAMETER_JSON_SYNTAX_ERROR)
  }
  const shape = jsonContainerError(parsed)
  if (shape !== true) {
    throw new Error(shape)
  }
  return parsed as JsonObject | JsonArray
}

function stringValueError(value: unknown): string | true {
  if (typeof value !== 'string') {
    return PARAMETER_STRING_VALUE_ERROR
  }
  if (value.length > MAX_STRING_VALUE_LENGTH) {
    return PARAMETER_STRING_LENGTH_ERROR
  }
  return true
}

function jsonContainerError(value: unknown): string | true {
  if (!isJsonContainer(value)) {
    return PARAMETER_JSON_SHAPE_ERROR
  }
  if (jsonDepth(value, 1) > MAX_JSON_DEPTH) {
    return PARAMETER_JSON_DEPTH_ERROR
  }
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return PARAMETER_JSON_SYNTAX_ERROR
  }
  if (serialized.length > MAX_JSON_CHARS) {
    return PARAMETER_JSON_SIZE_ERROR
  }
  return true
}

function isJsonContainer(value: unknown): value is JsonObject | JsonArray {
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry))
  }
  if (value === null || typeof value !== 'object') {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return false
  }
  return Object.values(value).every((entry) => isJsonValue(entry))
}

function isJsonValue(value: unknown): boolean {
  if (value === null) {
    return true
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  return isJsonContainer(value)
}

function jsonDepth(value: unknown, depth: number): number {
  if (!value || typeof value !== 'object') {
    return depth
  }
  const children = Array.isArray(value) ? value : Object.values(value)
  let maxDepth = depth
  for (const child of children) {
    maxDepth = Math.max(maxDepth, jsonDepth(child, depth + 1))
  }
  return maxDepth
}

export function isParameterValue(value: unknown): value is ParameterValue {
  return (
    valueMatchesType('string', value) === true ||
    valueMatchesType('number', value) === true ||
    valueMatchesType('boolean', value) === true ||
    jsonContainerError(value) === true
  )
}
