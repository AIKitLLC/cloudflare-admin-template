import type { Where } from 'payload'

import { ID_IN_CHUNK } from '../constants'
import { toPayloadIds } from '../ids/id-set'
import { matchNothing } from './match-nothing'

/**
 * Prefer {@link wherePathContains} for scope trees.
 * An `id` list is inlined as SQL literals on D1 (`limitedBoundParameters`), so it does not
 * consume the 100 bound-parameter budget. A relationship `in` list is bound twice per id and
 * will fail once the closed set grows past a few dozen nodes.
 */
export function whereIdIn(field: string, ids: ReadonlySet<string>): Where {
  if (ids.size === 0) {
    return matchNothing()
  }
  return {
    [field]: {
      in: toPayloadIds(ids),
    },
  }
}

/**
 * Plain `id IN` lists. Document ids are inlined on D1, and each chunk stays
 * under the bound-parameter cap if a caller treats the list as bound values.
 */
export function whereDocumentIds(ids: readonly (number | string)[]): Where {
  const unique = [...new Set(ids.map((id) => String(id)).filter((id) => id.length > 0))]
  if (unique.length === 0) {
    return matchNothing()
  }
  const chunks: Where[] = []
  for (let index = 0; index < unique.length; index += ID_IN_CHUNK) {
    chunks.push(whereIdIn('id', new Set(unique.slice(index, index + ID_IN_CHUNK))))
  }
  if (chunks.length === 1) {
    return chunks[0]
  }
  return { or: chunks }
}
