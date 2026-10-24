import { APIError, type PayloadRequest } from 'payload'

import { userGrantsFullAccess } from '../../access'
import { exportCollection } from '../../access'
import { SYSTEM_PARAMETERS_SLUG } from '../constants'
import { PARAMETER_VALUE_QUERY_ERROR } from '../validation/messages'

type ValueQuery = {
  where?: unknown
  sort?: unknown
  field?: unknown
}

export async function refuseValueQuery(hookArgs: {
  args: object
  overrideAccess?: boolean
  req: PayloadRequest
}): Promise<void> {
  const query = hookArgs.args as ValueQuery
  await assertValueQueryAllowed(hookArgs.req, query, Boolean(hookArgs.overrideAccess))
}

export async function guardSystemParameterExport(req: PayloadRequest): Promise<Response> {
  const query = (req.query ?? {}) as ValueQuery
  await assertValueQueryAllowed(req, query)
  return exportCollection(req, SYSTEM_PARAMETERS_SLUG)
}

export async function assertValueQueryAllowed(
  req: PayloadRequest,
  query: ValueQuery,
  overrideAccess = false,
): Promise<void> {
  if (overrideAccess) {
    return
  }
  if (
    !queryTargetsValue(query.where) &&
    !sortTargetsValue(query.sort) &&
    !fieldTargetsValue(query.field)
  ) {
    return
  }
  if (await userGrantsFullAccess(req)) {
    return
  }
  throw new APIError(PARAMETER_VALUE_QUERY_ERROR, 400)
}

export function queryTargetsValue(where: unknown): boolean {
  if (!where || typeof where !== 'object') {
    return false
  }
  if (Array.isArray(where)) {
    return where.some((entry) => queryTargetsValue(entry))
  }
  for (const [key, child] of Object.entries(where as Record<string, unknown>)) {
    const logical = key.trim().toLowerCase()
    if (logical === 'and' || logical === 'or') {
      if (queryTargetsValue(child)) {
        return true
      }
      continue
    }
    if (pathTargetsValue(key)) {
      return true
    }
  }
  return false
}

export function sortTargetsValue(sort: unknown): boolean {
  const parts = Array.isArray(sort) ? sort : typeof sort === 'string' ? sort.split(',') : []
  return parts.some((part) => pathTargetsValue(String(part)))
}

export function fieldTargetsValue(field: unknown): boolean {
  return typeof field === 'string' && pathTargetsValue(field)
}

function pathTargetsValue(path: string): boolean {
  const normalized = path.trim().replace(/__/g, '.').replace(/^-/, '')
  const segment = normalized.split('.')[0]
  return segment === 'value'
}
