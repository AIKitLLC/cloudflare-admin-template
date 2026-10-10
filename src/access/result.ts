import type { Where } from 'payload'

import type { AccessConstraint } from './types'

export function isWhereConstraint(value: AccessConstraint): value is Where {
  return typeof value === 'object' && value !== null
}

export function isAccessGranted(value: AccessConstraint): boolean {
  return value !== false
}
