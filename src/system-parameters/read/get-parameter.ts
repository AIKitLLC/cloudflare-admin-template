import type { Payload } from 'payload'

import { isolateParameterCache } from '../cache/isolate-parameter-cache'
import type { ParameterSnapshot, ParameterValue, ParameterValueType } from '../types'

export class ParameterTypeMismatchError extends Error {
  readonly key: string
  readonly expected: ParameterValueType
  readonly actual: ParameterValueType

  constructor(key: string, expected: ParameterValueType, actual: ParameterValueType) {
    super(`Parameter "${key}" is stored as ${actual}, not ${expected}.`)
    this.name = 'ParameterTypeMismatchError'
    this.key = key
    this.expected = expected
    this.actual = actual
  }
}

export async function getParameter(
  payload: Payload,
  key: string,
  options: { default: string },
): Promise<string>
export async function getParameter(
  payload: Payload,
  key: string,
  options: { default: number },
): Promise<number>
export async function getParameter(
  payload: Payload,
  key: string,
  options: { default: boolean },
): Promise<boolean>
export async function getParameter<T extends Record<string, unknown> | unknown[]>(
  payload: Payload,
  key: string,
  options: { default: T },
): Promise<T>
export async function getParameter(
  payload: Payload,
  key: string,
): Promise<ParameterValue | undefined>
export async function getParameter(
  payload: Payload,
  key: string,
  options?: { default?: ParameterValue },
): Promise<ParameterValue | undefined> {
  const snapshot = await isolateParameterCache(payload).read(key)
  if (!snapshot) {
    if (options && 'default' in options) {
      return options.default
    }
    return undefined
  }
  if (options && 'default' in options && options.default !== undefined) {
    assertDefaultMatchesStoredType(key, snapshot, options.default)
  }
  return snapshot.value
}

function assertDefaultMatchesStoredType(
  key: string,
  snapshot: ParameterSnapshot,
  defaultValue: ParameterValue,
): void {
  const expected = typeOfDefault(defaultValue)
  if (snapshot.valueType !== expected) {
    throw new ParameterTypeMismatchError(key, expected, snapshot.valueType)
  }
}

function typeOfDefault(value: ParameterValue): ParameterValueType {
  if (typeof value === 'string') {
    return 'string'
  }
  if (typeof value === 'number') {
    return 'number'
  }
  if (typeof value === 'boolean') {
    return 'boolean'
  }
  return 'json'
}
