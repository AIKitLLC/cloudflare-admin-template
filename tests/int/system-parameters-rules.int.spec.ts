import { Forbidden, ValidationError, type PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { REDACTED_PARAMETER_VALUE } from '@/system-parameters/constants'
import { recordSystemParameterAudit } from '@/system-parameters/hooks/record-audit'
import {
  fieldTargetsValue,
  queryTargetsValue,
  refuseValueQuery,
  sortTargetsValue,
} from '@/system-parameters/query/refuse-value-query'
import {
  buildSystemParameterAudit,
  readSystemParameterAudits,
  redactSystemParameterForAudit,
} from '@/system-parameters/sensitive/audit-view'
import { guardSensitiveUnmask } from '@/system-parameters/sensitive/guard-unmask'
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
  PARAMETER_VALUE_QUERY_ERROR,
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

    const unmask: ParameterWriteData = {
      key: 'flags',
      category: 'features',
      valueType: 'string',
      value: null,
      sensitive: false,
    }
    prepareSystemParameterWrite({
      data: unmask,
      operation: 'update',
      originalDoc: { ...unmask, value: 'hidden-value', sensitive: true },
    })
    expect(unmask.value).toBeNull()
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
    expect(previous.value).toBe('old')
    expect(next.value).toBe('new')

    const copy = redactSystemParameterForAudit(previous)
    expect(copy.value).toEqual(REDACTED_PARAMETER_VALUE)
    expect(copy).not.toBe(previous)
    expect(previous.value).toBe('old')

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

  it('keeps a redacted audit record per document id without changing the docs', () => {
    const req = { context: {} } as PayloadRequest
    const firstPrevious = {
      id: 4,
      key: 'flags',
      category: 'ops',
      valueType: 'string' as const,
      value: 'secret-b',
      sensitive: true,
    }
    const second = {
      id: 9,
      key: 'mode',
      category: 'ops',
      valueType: 'string' as const,
      value: 'other-secret',
      sensitive: true,
    }
    recordSystemParameterAudit({
      collection: null as never,
      context: req.context,
      data: {},
      doc: { ...firstPrevious, value: 'secret-a' },
      operation: 'update',
      previousDoc: firstPrevious,
      req,
    })
    recordSystemParameterAudit({
      collection: null as never,
      context: req.context,
      data: {},
      doc: second,
      operation: 'create',
      previousDoc: undefined,
      req,
    })
    const audits = readSystemParameterAudits(req.context)
    expect(Object.keys(audits).sort()).toEqual(['4', '9'])
    expect(audits['4']?.previous?.value).toEqual(REDACTED_PARAMETER_VALUE)
    expect(audits['9']?.next?.value).toEqual(REDACTED_PARAMETER_VALUE)
    expect(JSON.stringify(audits)).not.toContain('secret')
    expect(firstPrevious.value).toBe('secret-b')
    expect(second.value).toBe('other-secret')
  })

  it('blocks an unmask that omits a replacement, including for overrideAccess', async () => {
    const req = { context: {}, user: null } as PayloadRequest
    const siblingData: ParameterWriteData = { sensitive: false }
    await expect(
      guardSensitiveUnmask({
        operation: 'update',
        originalDoc: { sensitive: true, value: 'stored-secret' },
        overrideAccess: false,
        req,
        siblingData,
      }),
    ).rejects.toBeInstanceOf(Forbidden)
    expect(siblingData.value).toBeUndefined()

    await expect(
      guardSensitiveUnmask({
        operation: 'update',
        originalDoc: { sensitive: true, value: 'stored-secret' },
        overrideAccess: true,
        req,
        siblingData: { sensitive: false, value: null },
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    const replacement: ParameterWriteData = { sensitive: false, value: 'next-public' }
    await guardSensitiveUnmask({
      operation: 'update',
      originalDoc: { sensitive: true, value: 'stored-secret' },
      overrideAccess: true,
      req,
      siblingData: replacement,
    })
    expect(replacement.value).toBe('next-public')
  })

  it('detects value filters and sorts, including nested where clauses', () => {
    expect(queryTargetsValue({ key: { equals: 'mode' } })).toBe(false)
    expect(queryTargetsValue({ value: { like: 'abc%' } })).toBe(true)
    expect(
      queryTargetsValue({ and: [{ key: { equals: 'mode' } }, { value: { equals: 'x' } }] }),
    ).toBe(true)
    expect(queryTargetsValue({ AND: [{ value: { like: 'a%' } }] })).toBe(true)
    expect(queryTargetsValue({ Or: [{ key: { equals: 'mode' } }] })).toBe(false)
    expect(queryTargetsValue({ Or: [{ value__flag: { like: 'a%' } }] })).toBe(true)
    expect(queryTargetsValue({ 'value.flag': { exists: true } })).toBe(true)
    expect(sortTargetsValue('key')).toBe(false)
    expect(sortTargetsValue('-value')).toBe(true)
    expect(sortTargetsValue('category,-value')).toBe(true)
    expect(sortTargetsValue(['category', '-value__flag'])).toBe(true)
    expect(fieldTargetsValue('value')).toBe(true)
    expect(fieldTargetsValue('value__flag')).toBe(true)
    expect(fieldTargetsValue('key')).toBe(false)
  })

  it('refuses findDistinct on a value path for a user without full access', async () => {
    const req = { context: {}, user: null } as PayloadRequest
    await expect(
      refuseValueQuery({
        args: { field: 'value__flag' },
        overrideAccess: false,
        req,
      }),
    ).rejects.toMatchObject({ message: PARAMETER_VALUE_QUERY_ERROR, status: 400 })
  })
})
