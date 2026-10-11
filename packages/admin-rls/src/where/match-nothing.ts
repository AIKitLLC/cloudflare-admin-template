import type { Where } from 'payload'

/** A Where that matches no row. Empty `in` lists are not valid SQL. */
export function matchNothing(): Where {
  return {
    and: [{ id: { exists: true } }, { id: { exists: false } }],
  }
}
