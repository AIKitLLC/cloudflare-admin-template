import type { PermissionDefinition } from '@aikit/admin-rbac'
import { JOBS_RETRY_KEY, JOBS_SLUG, JOBS_TRIGGER_KEY } from '../constants'

const suppressed = [
  `${JOBS_SLUG}:create`,
  `${JOBS_SLUG}:update`,
  `${JOBS_SLUG}:delete`,
  `${JOBS_SLUG}:export`,
]

export function jobDispatchDefinitions(): PermissionDefinition[] {
  return [
    {
      key: JOBS_TRIGGER_KEY,
      label: 'Jobs · Trigger',
      groupLabel: 'Job',
      collectionSlug: JOBS_SLUG,
      action: 'trigger',
    },
    {
      key: JOBS_RETRY_KEY,
      label: 'Jobs · Retry',
      groupLabel: 'Job',
      collectionSlug: JOBS_SLUG,
      action: 'retry',
    },
  ]
}

export function suppressedJobPermissionKeys(): string[] {
  return suppressed
}
