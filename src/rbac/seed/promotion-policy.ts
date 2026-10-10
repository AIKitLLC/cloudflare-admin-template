export function hasAssignedRoles(roles: unknown): boolean {
  return Array.isArray(roles) && roles.length > 0
}

export function shouldPromoteUnassignedUsers(users: { roles?: unknown }[]): boolean {
  return users.length > 0 && users.every((user) => !hasAssignedRoles(user.roles))
}

export function shouldAssignSuperAdminOnCreate(args: {
  operation: string
  assignedRoleCount: number
  totalUsers: number
}): boolean {
  return args.operation === 'create' && args.assignedRoleCount === 0 && args.totalUsers === 1
}
