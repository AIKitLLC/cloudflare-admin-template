import { registerRowScopeContributor } from '../access/extensions'
import { contributeRowScope } from './contribute-row-scope'

let registered = false

export function ensureRowScopeRegistered(): void {
  if (registered) {
    return
  }
  registered = true
  registerRowScopeContributor(contributeRowScope)
}
