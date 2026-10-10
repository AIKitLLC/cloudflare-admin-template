import type { CollectionSlug, Payload, PayloadRequest } from 'payload'

import { SYSTEM_PARAMETERS_SLUG } from '../constants'
import { keyLooksLikeSecret } from './secret-key'
import { PARAMETER_KEY_UNIQUE_ERROR, PARAMETER_SECRET_KEY_ERROR } from './messages'
import { parameterSlugError } from './slug'
import { validateTypedParameterValue } from './typed-value'

export async function validateParameterKey(
  value: unknown,
  options?: { id?: unknown; req?: PayloadRequest },
): Promise<string | true> {
  const format = parameterSlugError(value, 'key')
  if (format !== true) {
    return format
  }
  if (keyLooksLikeSecret(value as string)) {
    return PARAMETER_SECRET_KEY_ERROR
  }
  if (options?.req && (await keyAlreadyExists(options.req, value as string, options.id))) {
    return PARAMETER_KEY_UNIQUE_ERROR
  }
  return true
}

async function keyAlreadyExists(
  req: PayloadRequest,
  key: string,
  id: unknown,
): Promise<boolean> {
  const payload: Payload = req.payload
  const existing = await payload.find({
    collection: SYSTEM_PARAMETERS_SLUG as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      key: {
        equals: key,
      },
    },
  })
  const found = existing.docs[0] as { id?: number | string } | undefined
  if (!found) {
    return false
  }
  if (id === undefined || id === null) {
    return true
  }
  return String(found.id) !== String(id)
}

export function validateParameterCategory(value: unknown): string | true {
  return parameterSlugError(value, 'category')
}

export function validateParameterValueField(
  value: unknown,
  options: { siblingData?: { valueType?: unknown }; jsonError?: unknown },
): string | true {
  return validateTypedParameterValue({
    value,
    valueType: options.siblingData?.valueType,
    jsonError: options.jsonError,
  })
}
