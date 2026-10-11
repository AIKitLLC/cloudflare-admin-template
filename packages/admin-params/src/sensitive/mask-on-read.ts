import type { CollectionAfterReadHook } from 'payload'

import { REVEAL_SENSITIVE_PARAMETER_VALUE } from '../constants'

export const maskSensitiveParameterOnRead: CollectionAfterReadHook = ({ doc, req }) => {
  if (req.context?.[REVEAL_SENSITIVE_PARAMETER_VALUE]) {
    return doc
  }
  if (!doc?.sensitive) {
    return doc
  }
  return {
    ...doc,
    value: null,
  }
}
