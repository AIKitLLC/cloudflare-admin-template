import { APIError } from 'payload'

import { SCOPE_ASSIGNMENT_ERROR } from '../errors'

/**
 * Keeps assignments the actor cannot see, and accepts adds and removals inside the actor's scope.
 * A new id outside that scope is refused.
 */
export function mergeScopeField(
  previous: ReadonlySet<string>,
  submitted: ReadonlySet<string>,
  grantable: ReadonlySet<string>,
): Set<string> {
  for (const id of submitted) {
    if (!grantable.has(id) && !previous.has(id)) {
      throw new APIError(SCOPE_ASSIGNMENT_ERROR, 403)
    }
  }
  const next = new Set<string>()
  for (const id of submitted) {
    if (grantable.has(id)) {
      next.add(id)
    }
  }
  for (const id of previous) {
    if (!grantable.has(id)) {
      next.add(id)
    }
  }
  return next
}
