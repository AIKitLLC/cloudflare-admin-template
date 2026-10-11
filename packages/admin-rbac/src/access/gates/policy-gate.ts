import { beforeGrantGates } from '../extensions'
import type { AccessGate } from '../types'

export const policyGate: AccessGate = {
  name: 'policy',
  async evaluate(context) {
    for (const gate of beforeGrantGates) {
      const decision = await gate.evaluate(context)
      if (decision === false) {
        return false
      }
    }
    return undefined
  },
}
