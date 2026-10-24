import { registerRowScopeContributor } from '../access'
import { contributeRowScope } from './contribute-row-scope'

let registered = false

export function ensureRowScopeRegistered(): void {
  if (registered) {
    return
  }
  registered = true
  registerRowScopeContributor(contributeRowScope)
}
