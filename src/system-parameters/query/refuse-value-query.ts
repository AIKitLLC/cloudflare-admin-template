import { APIError, type PayloadRequest } from 'payload'

import { userGrantsFullAccess } from '../../access'

import { PARAMETER_VALUE_QUERY_ERROR } from '../validation/messages'

export async function refuseValueQuery(hookArgs: {
  args: object
  overrideAccess?: boolean
  req: PayloadRequest
}): Promise<void> {
  const query = hookArgs.args as { where?: unknown; sort?: unknown }
  if (hookArgs.overrideAccess) {
    return
  }
  if (!queryTargetsValue(query.where) && !sortTargetsValue(query.sort)) {
    return
  }
  if (await userGrantsFullAccess(hookArgs.req)) {
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
    if (key === 'and' || key === 'or') {
      if (queryTargetsValue(child)) {
        return true
      }
      continue
    }
    if (key === 'value' || key.startsWith('value.')) {
      return true
    }
  }
  return false
}

export function sortTargetsValue(sort: unknown): boolean {
  const parts = Array.isArray(sort) ? sort : typeof sort === 'string' ? sort.split(',') : []
  return parts.some((part) => {
    const name = String(part).trim().replace(/^-/, '')
    return name === 'value' || name.startsWith('value.')
  })
}
