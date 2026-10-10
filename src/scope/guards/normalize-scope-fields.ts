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

/** Keeps ancestor assignments and refuses a direct list past the save cap. */
export async function collapseAndCapScopeFields(
  req: PayloadRequest,
  data: Record<string, unknown>,
): Promise<void> {
  const touched = USER_SCOPE_FIELDS.filter((field) => data[field] !== undefined)
  if (touched.length === 0) {
    return
  }
  const catalog = await loadScopeCatalog(req)
  for (const field of touched) {
    const collapsed = collapseCoveredIds([...idSet(data[field])], PARENTS[field](catalog))
    if (collapsed.length > MAX_DIRECT_ASSIGNMENTS) {
      throw new APIError(SCOPE_ASSIGNMENT_LIMIT_ERROR, 400)
    }
    data[field] = toPayloadIds(collapsed)
  }
}
