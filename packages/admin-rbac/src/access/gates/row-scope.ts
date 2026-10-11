import type { Where } from 'payload'

import { rowScopeContributors } from '../extensions'
import type { AccessConstraint, AccessEvaluationContext } from '../types'

export async function applyRowScope(
  context: AccessEvaluationContext,
): Promise<AccessConstraint | undefined> {
  const constraints: Where[] = []
  let explicitAllow = false
  for (const contributor of rowScopeContributors) {
    const constraint = await contributor(context)
    if (constraint === false) {
      return false
    }
    if (constraint === true) {
      explicitAllow = true
      continue
    }
    if (constraint) {
      constraints.push(constraint)
    }
  }
  if (constraints.length === 0) {
    return explicitAllow ? true : undefined
  }
  if (constraints.length === 1) {
    return constraints[0]
  }
  return { and: constraints }
}
