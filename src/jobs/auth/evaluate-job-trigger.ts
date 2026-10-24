import type { PayloadRequest } from 'payload'

import { loadUserGrants } from '../../access'
import { getJob } from '../registry/job-registry'
import { evaluateJobDispatch } from './evaluate-job-dispatch'

export async function evaluateJobTrigger(req: PayloadRequest, jobName: string): Promise<boolean> {
  if (!(await evaluateJobDispatch(req, 'trigger'))) {
    return false
  }
  const definition = getJob(jobName)
  if (!definition) {
    return false
  }
  const grants = await loadUserGrants(req)
  if (definition.requiresFullAccess) {
    return grants?.fullAccess === true
  }
  if (definition.permissionKey) {
    return grants?.fullAccess === true || grants?.permissionKeys.has(definition.permissionKey) === true
  }
  return true
}
