import { registerRoleGrantCheck, registerRowScopeContributor, registerUserTargetCheck } from '@aikit/admin-rbac'

import { attachRowScopeHooks } from './attach-row-scope-hooks'
import { contributeRowScope } from './contribute-row-scope'
import { assertRoleHoldersWithinActorScope } from './guards/assert-role-holders-within-actor-scope'
import { assertUserWithinActorScope } from './guards/assert-user-within-actor-scope'

let registered = false

export function ensureRowScopeRegistered(): void {
  if (registered) {
    return
  }
  registered = true
  registerRowScopeContributor(contributeRowScope)
  registerUserTargetCheck(assertUserWithinActorScope)
  registerRoleGrantCheck(assertRoleHoldersWithinActorScope)
}

export { attachRowScopeHooks }
