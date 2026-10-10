import { relationIds } from '../../access/relation-id'

export function roleIdList(value: unknown): string[] {
  return relationIds(value)
}

export function sameRoleIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  const rightIds = new Set(right)
  return left.every((id) => rightIds.has(id))
}

export function changedRoleIds(previous: string[], next: string[]): string[] {
  const previousIds = new Set(previous)
  const nextIds = new Set(next)
  const changed: string[] = []
  for (const id of previousIds) {
    if (!nextIds.has(id)) {
      changed.push(id)
    }
  }
  for (const id of nextIds) {
    if (!previousIds.has(id)) {
      changed.push(id)
    }
  }
  return changed
}
