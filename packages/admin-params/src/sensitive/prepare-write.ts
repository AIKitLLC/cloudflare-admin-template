import { ValidationError } from 'payload'

import { SYSTEM_PARAMETERS_SLUG } from '../constants'
import type { ParameterWriteData } from '../types'
import { PARAMETER_JSON_SYNTAX_ERROR } from '../validation/messages'
import { isParameterValueType, parseJsonParameterString } from '../validation/typed-value'

export function prepareSystemParameterWrite(args: {
  data: ParameterWriteData
  originalDoc?: ParameterWriteData | null
  operation: 'create' | 'update'
}): void {
  restoreMaskedSensitiveValue(args)
  parseJsonStringValue(args.data)
}

function restoreMaskedSensitiveValue(args: {
  data: ParameterWriteData
  originalDoc?: ParameterWriteData | null
  operation: 'create' | 'update'
}): void {
  if (args.operation !== 'update' || args.data.value !== null || !args.originalDoc) {
    return
  }
  if (
    args.data.sensitive === false ||
    args.data.sensitive === 0 ||
    args.data.sensitive === 'false'
  ) {
    return
  }
  const staysSensitive = Boolean(args.originalDoc.sensitive) || Boolean(args.data.sensitive)
  if (!staysSensitive) {
    return
  }
  args.data.value = args.originalDoc.value
}

function parseJsonStringValue(data: ParameterWriteData): void {
  const valueType = data.valueType
  if (!isParameterValueType(valueType) || valueType !== 'json' || typeof data.value !== 'string') {
    return
  }
  try {
    data.value = parseJsonParameterString(data.value)
  } catch (error) {
    const message = error instanceof Error ? error.message : PARAMETER_JSON_SYNTAX_ERROR
    throw new ValidationError({
      collection: SYSTEM_PARAMETERS_SLUG,
      errors: [{ message, path: 'value' }],
    })
  }
}
