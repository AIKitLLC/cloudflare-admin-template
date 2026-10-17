import { registerCatalogContributor } from '../../rbac/catalog/catalog-contributors'
import { jobDispatchDefinitions, suppressedJobPermissionKeys } from './dispatch-definitions'
import { jobPrivilegeDefinitions } from './job-privilege-definitions'

let registered = false

export function registerDispatchPermissions(): void {
  if (registered) {
    return
  }
  registered = true
  registerCatalogContributor({
    definitions: () => [...jobDispatchDefinitions(), ...jobPrivilegeDefinitions()],
    suppressKeys: suppressedJobPermissionKeys,
  })
}
