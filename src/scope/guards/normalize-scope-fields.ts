import type { PayloadRequest } from 'payload'
import { APIError } from 'payload'

import { MAX_DIRECT_ASSIGNMENTS, USER_SCOPE_FIELDS, type UserScopeField } from '../constants'
import { SCOPE_ASSIGNMENT_LIMIT_ERROR } from '../errors'
import { idSet, toPayloadIds } from '../ids/id-set'
import { loadScopeCatalog } from '../resolve/load-scope-catalog'
import { parentMap } from '../tree/scope-tree'
import type { ScopeCatalog } from '../types'
import { collapseCoveredIds } from '../where/collapse-covered-ids'

const PARENTS: Record<UserScopeField, (catalog: ScopeCatalog) => Map<string, string | undefined>> =
  {
    organizations: (catalog) => parentMap(catalog.organizations),
    branches: (catalog) => parentMap(catalog.branches),
    dataClasses: (catalog) => parentMap(catalog.dataClasses),
  }

/**
 * Keeps ancestor assignments and refuses a combined direct list past the save cap.
 * Fields missing from this write are counted from the stored user, so a later
 * update cannot grow a different dimension past the total.
 */
export async function collapseAndCapScopeFields(
  req: PayloadRequest,
  data: Record<string, unknown>,
  original?: Record<string, unknown> | null,
): Promise<void> {
  const touched = USER_SCOPE_FIELDS.filter((field) => data[field] !== undefined)
  if (touched.length === 0) {
    return
  }
  const catalog = await loadScopeCatalog(req)
  const collapsedByField = new Map<UserScopeField, string[]>()
  let total = 0
  for (const field of USER_SCOPE_FIELDS) {
    const source = data[field] !== undefined ? data[field] : original?.[field]
    const collapsed = collapseCoveredIds([...idSet(source)], PARENTS[field](catalog))
    collapsedByField.set(field, collapsed)
    total += collapsed.length
  }
  if (total > MAX_DIRECT_ASSIGNMENTS) {
    throw new APIError(SCOPE_ASSIGNMENT_LIMIT_ERROR, 400)
  }
  for (const field of touched) {
    data[field] = toPayloadIds(collapsedByField.get(field) ?? [])
  }
}
