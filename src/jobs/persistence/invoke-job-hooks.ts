import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { JOB_SYSTEM_WRITE, SKIP_JOB_ENQUEUE } from '../constants'
import { JOBS_SLUG } from '../constants'
import type { StoredJob } from '../types'

type HookDoc = Record<string, unknown>

export async function invokeJobChangeHooks(
  payload: Payload,
  previousDoc: StoredJob | HookDoc,
  doc: StoredJob | HookDoc,
): Promise<void> {
  const collection = payload.config.collections.find((item) => item.slug === JOBS_SLUG)
  if (!collection) {
    return
  }
  const req = await createLocalReq(
    {
      context: {
        [JOB_SYSTEM_WRITE]: true,
        [SKIP_JOB_ENQUEUE]: true,
      },
    },
    payload,
  )
  const data: HookDoc = { ...(doc as HookDoc) }
  try {
    await runBeforeChange(collection.hooks?.beforeChange, data, previousDoc, req, collection)
    await runAfterChange(collection.hooks?.afterChange, data, previousDoc, doc, req, collection)
  } catch (error) {
    payload.logger.error({
      err: error,
      msg: 'Job change hooks failed after the row was updated.',
    })
  }
}

async function runBeforeChange(
  hooks: unknown[] | undefined,
  data: HookDoc,
  previousDoc: StoredJob | HookDoc,
  req: PayloadRequest,
  collection: unknown,
): Promise<void> {
  if (!hooks) {
    return
  }
  let next = data
  for (const hook of hooks) {
    if (typeof hook !== 'function') {
      continue
    }
    const result = await hook({
      collection,
      context: req.context,
      data: next,
      operation: 'update',
      originalDoc: previousDoc,
      req,
    })
    if (result && typeof result === 'object') {
      next = result as HookDoc
    }
  }
}

async function runAfterChange(
  hooks: unknown[] | undefined,
  data: HookDoc,
  previousDoc: StoredJob | HookDoc,
  doc: StoredJob | HookDoc,
  req: PayloadRequest,
  collection: unknown,
): Promise<void> {
  if (!hooks) {
    return
  }
  for (const hook of hooks) {
    if (typeof hook !== 'function') {
      continue
    }
    await hook({
      collection,
      context: req.context,
      data,
      doc,
      operation: 'update',
      previousDoc,
      req,
    })
  }
}
