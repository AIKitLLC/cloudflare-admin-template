import type { PermissionDefinition } from '../../rbac'
import { JOBS_SLUG } from '../constants'
import { listJobDefinitions } from '../registry/job-registry'

export function jobPrivilegeDefinitions(): PermissionDefinition[] {
  return listJobDefinitions()
    .filter((job) => job.permissionKey && !job.name.startsWith('test.'))
    .map((job) => ({
      key: job.permissionKey as string,
      label: `Jobs · Trigger ${job.name}`,
      groupLabel: 'Job',
      collectionSlug: JOBS_SLUG,
      action: 'trigger' as const,
    }))
}
