import type { Where } from 'payload'

import { SCOPE_PATH_FIELD } from '../constants'
import { matchNothing } from './match-nothing'

/** Payload `contains` wraps the value in `%`, so the stored path must keep `/id/` segments. */
export function scopePathContainsToken(id: string): string {
  return `/${id}/`
}

export function rootScopePath(id: string | number): string {
  return `/${id}/`
}

export function childScopePath(parentPath: string, id: string | number): string {
  const prefix = parentPath.endsWith('/') ? parentPath : `${parentPath}/`
  return `${prefix}${id}/`
}

/**
 * Match a node, or a user relationship to a node, whose ancestor path includes one of these ids.
 * One bound parameter per direct assignment, not per descendant.
 * Returns undefined when there is nothing to match so callers can drop the clause.
 */
export function wherePathContains(field: string, ids: readonly string[]): Where | undefined {
  const tokens = [
    ...new Set(ids.filter((id) => id.length > 0).map((id) => scopePathContainsToken(id))),
  ]
  if (tokens.length === 0) {
    return undefined
  }
  if (tokens.length === 1) {
    return { [field]: { contains: tokens[0] } }
  }
  return {
    or: tokens.map((token) => ({ [field]: { contains: token } })),
  }
}

export function whereOwnPathContains(ids: readonly string[]): Where {
  return wherePathContains(SCOPE_PATH_FIELD, ids) ?? matchNothing()
}
