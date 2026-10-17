import { permissionKey } from '../permission-key'
import type { AccessGate } from '../types'

export const permissionGrantGate: AccessGate = {
  name: 'permission-grant',
  async evaluate(context) {
    const key = permissionKey(context.collectionSlug, context.action)
    if (context.grants?.permissionKeys.has(key)) {
      return true
    }
    return undefined
  },
}
