import { registerCatalogActions, registerCatalogContributor } from '@aikit/admin-rbac'
import { JOB_DISPATCH_ACTIONS } from '../constants'
import { jobDispatchDefinitions, suppressedJobPermissionKeys } from './dispatch-definitions'
import { jobPrivilegeDefinitions } from './job-privilege-definitions'

let registered = false

export function registerDispatchPermissions(): void {
  if (registered) {
    return
  }
  registered = true
  registerCatalogActions(JOB_DISPATCH_ACTIONS)
  registerCatalogContributor({
    definitions: () => [...jobDispatchDefinitions(), ...jobPrivilegeDefinitions()],
    suppressKeys: suppressedJobPermissionKeys,
  })
}
