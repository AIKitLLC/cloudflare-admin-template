import type { Where } from 'payload'

import { toPayloadIds } from '../ids/id-set'
import { matchNothing } from './match-nothing'

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
