export function hasAssignedRoles(roles: unknown): boolean {
  return Array.isArray(roles) && roles.length > 0
}

export function shouldPromoteUnassignedUsers(users: { roles?: unknown }[]): boolean {
  return users.length > 0 && users.every((user) => !hasAssignedRoles(user.roles))
}

export function earliestUser<T extends { id: number | string; createdAt?: string | null }>(
  users: T[],
): T | undefined {
  if (users.length === 0) {
    return undefined
  }
  return users.reduce((earliest, user) => (isEarlier(user, earliest) ? user : earliest))
}

function isEarlier(
  candidate: { id: number | string; createdAt?: string | null },
  current: { id: number | string; createdAt?: string | null },
): boolean {
  const created = compareCreatedAt(candidate.createdAt, current.createdAt)
  if (created !== 0) {
    return created < 0
  }
  return compareId(candidate.id, current.id) < 0
}

function compareCreatedAt(left?: string | null, right?: string | null): number {
  const leftAt = left ?? ''
  const rightAt = right ?? ''
  if (leftAt === rightAt) {
    return 0
  }
  return leftAt < rightAt ? -1 : 1
}

function compareId(left: number | string, right: number | string): number {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  const bothNumeric =
    Number.isInteger(leftNumber) &&
    Number.isInteger(rightNumber) &&
    String(leftNumber) === String(left).trim() &&
    String(rightNumber) === String(right).trim()
  if (bothNumeric) {
    return leftNumber - rightNumber
  }
  const leftId = String(left)
  const rightId = String(right)
  if (leftId === rightId) {
    return 0
  }
  return leftId < rightId ? -1 : 1
}

export function shouldAssignSuperAdminOnCreate(args: {
  operation: string
  assignedRoleCount: number
  totalUsers: number
}): boolean {
  return args.operation === 'create' && args.assignedRoleCount === 0 && args.totalUsers === 1
}
