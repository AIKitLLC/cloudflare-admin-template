import type { AccessGate } from '../types'

export const unauthenticatedGate: AccessGate = {
  name: 'unauthenticated',
  async evaluate(context) {
    if (context.req.user) {
      return undefined
    }
    if (context.options.anonymousRead && context.action === 'read') {
      return true
    }
    return false
  },
}
