import { describe, expect, it } from 'vitest'

import { REDACTED_PARAMETER_VALUE } from '@/system-parameters/constants'
import {
  buildSystemParameterAudit,
  redactSystemParameterHookArguments,
} from '@/system-parameters/sensitive/audit-view'
import { prepareSystemParameterWrite } from '@/system-parameters/sensitive/prepare-write'
import type { ParameterWriteData } from '@/system-parameters/types'
import { keyLooksLikeSecret } from '@/system-parameters/validation/secret-key'
import { parameterSlugError } from '@/system-parameters/validation/slug'
import {
  PARAMETER_BOOLEAN_VALUE_ERROR,
  PARAMETER_JSON_SHAPE_ERROR,
  PARAMETER_JSON_SYNTAX_ERROR,
  PARAMETER_NUMBER_VALUE_ERROR,
  PARAMETER_SECRET_KEY_ERROR,
  PARAMETER_STRING_VALUE_ERROR,
} from '@/system-parameters/validation/messages'
import { validateParameterKey } from '@/system-parameters/validation/field-validators'
import {
  parseJsonParameterString,
  validateTypedParameterValue,
} from '@/system-parameters/validation/typed-value'

describe('system parameter rules', () => {
  it('accepts lowercase kebab-case and rejects other key shapes', () => {
    expect(parameterSlugError('maintenance-mode', 'key')).toBe(true)
    expect(parameterSlugError('a', 'key')).toBe(true)
    expect(parameterSlugError('Feature-Flag', 'key')).not.toBe(true)
    expect(parameterSlugError('feature_flag', 'key')).not.toBe(true)
    expect(parameterSlugError('-flag', 'key')).not.toBe(true)
    expect(parameterSlugError('flag-', 'key')).not.toBe(true)
    expect(parameterSlugError('a--b', 'key')).not.toBe(true)
    expect(parameterSlugError('Has Space', 'category')).not.toBe(true)
  })

  it('refuses secret-like keys and allows ordinary operational keys', async () => {
    for (const key of ['api-key', 'stripe-secret', 'session-token', 'db-password', 'private-key']) {
      expect(keyLooksLikeSecret(key)).toBe(true)
      expect(await validateParameterKey(key)).toBe(PARAMETER_SECRET_KEY_ERROR)
    }
    expect(await validateParameterKey('maintenance-mode')).toBe(true)
    expect(await validateParameterKey('session-ttl-seconds')).toBe(true)
    expect(await validateParameterKey('external-api-endpoint')).toBe(true)
  })

  it('checks each value type, including JSON syntax and shape', () => {
    expect(
      validateTypedParameterValue({ value: '', valueType: 'string', jsonError: 'empty' }),
    ).toBe(true)
    expect(
      validateTypedParameterValue({ value: 'one', valueType: 'string', jsonError: 'plain text' }),
    ).toBe(true)
    expect(validateTypedParameterValue({ value: 0, valueType: 'number' })).toBe(true)
    expect(validateTypedParameterValue({ value: false, valueType: 'boolean' })).toBe(true)
    expect(validateTypedParameterValue({ value: { enabled: true }, valueType: 'json' })).toBe(true)
    expect(validateTypedParameterValue({ value: ['a'], valueType: 'json' })).toBe(true)

    expect(validateTypedParameterValue({ value: 1, valueType: 'string' })).toBe(
      PARAMETER_STRING_VALUE_ERROR,
    )
    expect(validateTypedParameterValue({ value: '12', valueType: 'number' })).toBe(
      PARAMETER_NUMBER_VALUE_ERROR,
    )
    expect(validateTypedParameterValue({ value: 'true', valueType: 'boolean' })).toBe(
      PARAMETER_BOOLEAN_VALUE_ERROR,
    )
    expect(validateTypedParameterValue({ value: 1, valueType: 'json' })).toBe(
      PARAMETER_JSON_SHAPE_ERROR,
    )
    expect(validateTypedParameterValue({ value: '{', valueType: 'json', jsonError: 'bad' })).toBe(
      PARAMETER_JSON_SYNTAX_ERROR,
    )
    expect(parseJsonParameterString('{"a":1}')).toEqual({ a: 1 })
    expect(() => parseJsonParameterString('{not json')).toThrow(PARAMETER_JSON_SYNTAX_ERROR)
    expect(() => parseJsonParameterString('12')).toThrow(PARAMETER_JSON_SHAPE_ERROR)
  })

  it('parses JSON strings before save and keeps a masked sensitive value', () => {
    const parsed: ParameterWriteData = {
      key: 'flags',
      category: 'features',
      valueType: 'json',
      value: '{"on":true}',
    }
    prepareSystemParameterWrite({ data: parsed, operation: 'create' })
    expect(parsed.value).toEqual({ on: true })

    const masked: ParameterWriteData = {
      key: 'flags',
      category: 'features',
      valueType: 'string',
      value: null,
      sensitive: true,
    }
    prepareSystemParameterWrite({
      data: masked,
      operation: 'update',
      originalDoc: { ...masked, value: 'hidden-value' },
    })
    expect(masked.value).toBe('hidden-value')
  })

  it('redacts sensitive values in the audit view and on hook arguments', () => {
    const previous = {
      id: 1,
      key: 'flags',
      category: 'ops',
      valueType: 'string',
      value: 'old',
      sensitive: true,
    }
    const next = {
      id: 1,
      key: 'flags',
      category: 'ops',
      valueType: 'string',
      value: 'new',
      sensitive: true,
    }
    const audit = buildSystemParameterAudit({ operation: 'update', previous, next })
    expect(audit.previous?.value).toEqual(REDACTED_PARAMETER_VALUE)
    expect(audit.next?.value).toEqual(REDACTED_PARAMETER_VALUE)
    expect(JSON.stringify(audit)).not.toContain('old')
    expect(JSON.stringify(audit)).not.toContain('new')

    const data = { sensitive: true, value: 'new' }
    const previousDoc = { sensitive: true, value: 'old' }
    redactSystemParameterHookArguments({ data, previousDoc })
    expect(data.value).toEqual(REDACTED_PARAMETER_VALUE)
    expect(previousDoc.value).toEqual(REDACTED_PARAMETER_VALUE)

    const plain = buildSystemParameterAudit({
      operation: 'create',
      next: {
        id: 2,
        key: 'mode',
        category: 'ops',
        valueType: 'boolean',
        value: false,
        sensitive: false,
      },
    })
    expect(plain.next?.value).toBe(false)
  })
})
