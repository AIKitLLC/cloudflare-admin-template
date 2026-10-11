import { permissionGrantGate } from '../gates/permission-grant-gate'
import { policyGate } from '../gates/policy-gate'
import { applyRowScope } from '../gates/row-scope'
import { selfServiceGate } from '../gates/self-service-gate'
import { superAdminGate } from '../gates/super-admin-gate'
import { unauthenticatedGate } from '../gates/unauthenticated-gate'
import type { AccessConstraint, AccessEvaluationContext, AccessGate } from '../types'

const gates: AccessGate[] = [
  policyGate,
  unauthenticatedGate,
  superAdminGate,
  permissionGrantGate,
  selfServiceGate,
]

/**
 * Chain of responsibility for collection access.
 * Full access returns before row scope. A permission grant then passes through
 * row-scope contributors. Self-service is a narrower Where and is not scoped again.
 */
export async function runAccessPipeline(
  context: AccessEvaluationContext,
): Promise<AccessConstraint> {
  for (const gate of gates) {
    const decision = await gate.evaluate(context)
    if (decision === undefined) {
      continue
    }
    if (decision === false) {
      return false
    }
    if (decision === true && gate.name === 'permission-grant') {
      return (await applyRowScope(context)) ?? true
    }
    return decision
  }
  return false
}
