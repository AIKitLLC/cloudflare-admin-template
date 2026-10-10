import type { Where } from 'payload'

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
