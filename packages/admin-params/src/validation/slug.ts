import { MAX_SLUG_LENGTH } from '../constants'
import { PARAMETER_CATEGORY_FORMAT_ERROR, PARAMETER_KEY_FORMAT_ERROR } from './messages'

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function parameterSlugError(value: unknown, kind: 'key' | 'category'): string | true {
  const message = kind === 'key' ? PARAMETER_KEY_FORMAT_ERROR : PARAMETER_CATEGORY_FORMAT_ERROR
  if (typeof value !== 'string') {
    return message
  }
  if (value.length < 1 || value.length > MAX_SLUG_LENGTH) {
    return message
  }
  if (!SLUG_PATTERN.test(value)) {
    return message
  }
  return true
}
