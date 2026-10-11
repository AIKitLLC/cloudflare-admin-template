import type { CollectionSlug, Payload } from 'payload'

import { REVEAL_SENSITIVE_PARAMETER_VALUE, SYSTEM_PARAMETERS_SLUG } from '../constants'
import type { ParameterSnapshot, ParameterValue } from '../types'
import { isParameterValueType, valueMatchesType } from '../validation/typed-value'

type ParameterRow = {
  key?: string | null
  valueType?: string | null
  value?: unknown
  sensitive?: boolean | null
}

export async function loadParameter(
  payload: Payload,
  key: string,
): Promise<ParameterSnapshot | null> {
  const found = await payload.find({
    collection: SYSTEM_PARAMETERS_SLUG as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    context: {
      [REVEAL_SENSITIVE_PARAMETER_VALUE]: true,
    },
    where: {
      key: {
        equals: key,
      },
    },
  })
  const row = found.docs[0] as ParameterRow | undefined
  if (!row || typeof row.key !== 'string' || !isParameterValueType(row.valueType)) {
    return null
  }
  if (valueMatchesType(row.valueType, row.value) !== true) {
    return null
  }
  return {
    key: row.key,
    valueType: row.valueType,
    value: row.value as ParameterValue,
    sensitive: Boolean(row.sensitive),
  }
}
