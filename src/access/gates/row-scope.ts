import type { Where } from 'payload'

import { rowScopeContributors } from '../extensions'
import type { AccessEvaluationContext } from '../types'

export async function applyRowScope(context: AccessEvaluationContext): Promise<Where | undefined> {
  const constraints: Where[] = []
  for (const contributor of rowScopeContributors) {
    const constraint = await contributor(context)
    if (constraint) {
      constraints.push(constraint)
    }
  }
  if (constraints.length === 0) {
    return undefined
  }
  if (constraints.length === 1) {
    return constraints[0]
  }
  return { and: constraints }
}
