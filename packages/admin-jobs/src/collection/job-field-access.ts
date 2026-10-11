import type { FieldAccess } from 'payload'

import { evaluateCollectionAccess } from '@aikit/admin-rbac'
import { isAccessGranted } from '@aikit/admin-rbac'
import { evaluateJobDispatch } from '../auth/evaluate-job-dispatch'
import { JOBS_SLUG } from '../constants'

export const jobDataReadAccess: FieldAccess = async ({ req }) => {
  const canRead = isAccessGranted(
    await evaluateCollectionAccess({
      req,
      collectionSlug: JOBS_SLUG,
      action: 'read',
    }),
  )
  if (canRead) {
    return true
  }
  if (await evaluateJobDispatch(req, 'trigger')) {
    return true
  }
  return evaluateJobDispatch(req, 'retry')
}

export const jobDataCreateAccess: FieldAccess = ({ req }) => evaluateJobDispatch(req, 'trigger')

export const jobDataUpdateAccess: FieldAccess = () => false

export const jobDataFieldAccess = {
  create: jobDataCreateAccess,
  read: jobDataReadAccess,
  update: jobDataUpdateAccess,
}
