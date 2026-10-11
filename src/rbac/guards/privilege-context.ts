export const SKIP_RBAC_PRIVILEGE_CHECKS = 'skipRbacPrivilegeChecks'

export function skipsPrivilegeChecks(context: unknown): boolean {
  if (!context || typeof context !== 'object') {
    return false
  }
  return (context as Record<string, unknown>)[SKIP_RBAC_PRIVILEGE_CHECKS] === true
}
