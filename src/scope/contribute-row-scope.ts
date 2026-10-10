import type { Where } from 'payload'

import type { AccessEvaluationContext } from '../access/types'
import { bindingFiltersRows } from './bindings/read-row-scope-binding'
import { loadEffectiveScope } from './resolve/load-effective-scope'
import { whereForBinding } from './where/where-for-binding'

export async function contributeRowScope(
  context: AccessEvaluationContext,
): Promise<Where | undefined> {
  if (context.action === 'create' || context.grants?.fullAccess || !context.req.user) {
    return undefined
  }
  const binding = context.options.rowScope
  if (!bindingFiltersRows(binding) || !binding) {
    return undefined
  }
  const scope = await loadEffectiveScope(context.req)
  return whereForBinding(binding, scope, context.action)
}
