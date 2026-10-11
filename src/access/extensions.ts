import type { AccessGate, RowScopeContributor } from './types'

/**
 * Deny-only gates that run before role grants.
 * Issue #4 (IP allowlists and access windows) registers a gate here.
 * Return false to deny the request, including full-access roles.
 * Any other result is ignored so a policy gate cannot skip RBAC.
 */
export const beforeGrantGates: AccessGate[] = []

/**
 * Issue #2 (row-level scoping) registers contributors here.
 * They run only after a collection permission grants access, and they do not
 * run for the full-access bypass. Return a Where clause to narrow rows.
 */
export const rowScopeContributors: RowScopeContributor[] = []

export function registerBeforeGrantGate(gate: AccessGate): () => void {
  beforeGrantGates.push(gate)
  return () => {
    const index = beforeGrantGates.indexOf(gate)
    if (index >= 0) {
      beforeGrantGates.splice(index, 1)
    }
  }
}

export function registerRowScopeContributor(contributor: RowScopeContributor): () => void {
  rowScopeContributors.push(contributor)
  return () => {
    const index = rowScopeContributors.indexOf(contributor)
    if (index >= 0) {
      rowScopeContributors.splice(index, 1)
    }
  }
}
