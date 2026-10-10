import type { PayloadRequest } from 'payload'

import { Forbidden } from 'payload'

import { readRbacCollectionOptions } from './options'
import { runAccessPipeline } from './pipeline/run-access-pipeline'
import { loadUserGrants } from './resolve/load-user-grants'
import { isAccessGranted } from './result'
import type { AccessConstraint, CollectionAction } from './types'

export async function evaluateCollectionAccess(args: {
  req: PayloadRequest
  collectionSlug: string
  action: CollectionAction
}): Promise<AccessConstraint> {
  const options = readRbacCollectionOptions(args.req, args.collectionSlug)
  const grants = await loadUserGrants(args.req)
  return runAccessPipeline({
    req: args.req,
    collectionSlug: args.collectionSlug,
    action: args.action,
    grants,
    options,
  })
}

export async function assertCollectionAction(args: {
  req: PayloadRequest
  collectionSlug: string
  action: CollectionAction
}): Promise<AccessConstraint> {
  const decision = await evaluateCollectionAccess(args)
  if (!isAccessGranted(decision)) {
    throw new Forbidden(args.req.t)
  }
  return decision
}
