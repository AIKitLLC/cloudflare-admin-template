import { Forbidden, ValidationError, type PayloadRequest } from 'payload'

import { userGrantsFullAccess } from '../../access'
import { SYSTEM_PARAMETERS_SLUG } from '../constants'
import type { ParameterWriteData } from '../types'
import { PARAMETER_UNMASK_VALUE_ERROR } from '../validation/messages'

export async function guardSensitiveUnmask(args: {
  operation: string
  originalDoc?: ParameterWriteData | null
  overrideAccess: boolean
  req: PayloadRequest
  siblingData: ParameterWriteData
}): Promise<void> {
  if (args.operation !== 'update' || !isSensitiveFlag(args.originalDoc?.sensitive)) {
    return
  }
  if (!isExplicitFalse(args.siblingData.sensitive)) {
    return
  }
  if (!args.overrideAccess && !(await userGrantsFullAccess(args.req))) {
    throw new Forbidden()
  }
  if (!hasReplacementValue(args.siblingData)) {
    throw new ValidationError({
      collection: SYSTEM_PARAMETERS_SLUG,
      errors: [{ message: PARAMETER_UNMASK_VALUE_ERROR, path: 'value' }],
    })
  }
}

function hasReplacementValue(data: ParameterWriteData): boolean {
  if (!Object.prototype.hasOwnProperty.call(data, 'value')) {
    return false
  }
  return data.value !== undefined && data.value !== null
}

function isSensitiveFlag(value: unknown): boolean {
  return value === true || value === 1 || value === 'true'
}

function isExplicitFalse(value: unknown): boolean {
  return value === false || value === 0 || value === 'false'
}
