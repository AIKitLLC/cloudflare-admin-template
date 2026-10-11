import type { Where } from 'payload'

import { toPayloadIds } from '../ids/id-set'
import { matchNothing } from './match-nothing'

/**
 * Document `id IN` is inlined as SQL literals on D1 (`limitedBoundParameters`),
 * so splitting the list does not reduce bound parameters. The practical ceiling
 * is SQLite's statement length, roughly 10–15k ids. Scope trees use
 * {@link wherePathContains} instead. This list is only for user visibility,
 * which Payload 3.82.1 cannot express as a nested has-many constraint.
 */
export function whereDocumentIds(ids: readonly (number | string)[]): Where {
  const unique = [...new Set(ids.map((id) => String(id)).filter((id) => id.length > 0))]
  if (unique.length === 0) {
    return matchNothing()
  }
  return {
    id: {
      in: toPayloadIds(unique),
    },
  }
}
