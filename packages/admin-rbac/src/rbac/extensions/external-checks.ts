import type { PayloadRequest } from 'payload'

export type UserTargetCheck = (req: PayloadRequest, target: unknown) => Promise<void>

export type RoleGrantCheck = (args: {
  req: PayloadRequest
  roleId: number | string
}) => Promise<void>

const userTargetChecks: UserTargetCheck[] = []
const roleGrantChecks: RoleGrantCheck[] = []

export function registerUserTargetCheck(check: UserTargetCheck): void {
  if (!userTargetChecks.includes(check)) {
    userTargetChecks.push(check)
  }
}

export function registerRoleGrantCheck(check: RoleGrantCheck): void {
  if (!roleGrantChecks.includes(check)) {
    roleGrantChecks.push(check)
  }
}

export async function runUserTargetChecks(req: PayloadRequest, target: unknown): Promise<void> {
  for (const check of userTargetChecks) {
    await check(req, target)
  }
}

export async function runRoleGrantChecks(args: {
  req: PayloadRequest
  roleId: number | string
}): Promise<void> {
  for (const check of roleGrantChecks) {
    await check(args)
  }
}
