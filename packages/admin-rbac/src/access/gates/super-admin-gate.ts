import type { AccessGate } from '../types'

export const superAdminGate: AccessGate = {
  name: 'super-admin',
  async evaluate(context) {
    if (context.grants?.fullAccess) {
      return true
    }
    return undefined
  },
}
