import type { CollectionBeforeOperationHook, Where } from 'payload'

import { JOB_QUERY_TOO_WIDE_MESSAGE, jobError } from '../../errors'
import { MAX_LIST_LIMIT, MAX_LIST_PAGE, MAX_WHERE_IN } from '../../constants'

type QueryArgs = {
  depth?: number
  id?: number | string
  limit?: number
  page?: number
  pagination?: boolean
  where?: Where
}

export const capJobQuery: CollectionBeforeOperationHook = ({ args, operation }) => {
  if (!args || (operation !== 'read' && operation !== 'count')) {
    return args
  }
  const next = args as QueryArgs
  if (operation === 'read' && next.id == null) {
    const requested = typeof next.limit === 'number' ? next.limit : MAX_LIST_LIMIT
    next.limit = Math.min(Math.max(requested, 1), MAX_LIST_LIMIT)
    next.pagination = true
    const page = typeof next.page === 'number' ? next.page : 1
    if (page > MAX_LIST_PAGE) {
      throw jobError(JOB_QUERY_TOO_WIDE_MESSAGE)
    }
    next.depth = 0
  }
  if (next.where) {
    assertBoundedWhere(next.where)
  }
  return args
}

function assertBoundedWhere(where: Where): void {
  if (!where || typeof where !== 'object') {
    return
  }
  if (Array.isArray(where.and)) {
    where.and.forEach(assertBoundedWhere)
  }
  if (Array.isArray(where.or)) {
    where.or.forEach(assertBoundedWhere)
  }
  for (const value of Object.values(where)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue
    }
    const clause = value as { in?: unknown }
    if (Array.isArray(clause.in) && clause.in.length > MAX_WHERE_IN) {
      throw jobError(JOB_QUERY_TOO_WIDE_MESSAGE)
    }
  }
}
