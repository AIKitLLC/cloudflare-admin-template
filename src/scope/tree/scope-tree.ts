import { APIError } from 'payload'

import { MAX_SCOPE_DEPTH } from '../constants'
import { SCOPE_CYCLE_ERROR } from '../errors'

/**
 * In-memory parent map for one scope dimension.
 * Descendant closure and cycle checks never query D1.
 */
export class ScopeTree {
  private readonly childrenByParent = new Map<string, string[]>()

  constructor(private readonly parentById: ReadonlyMap<string, string | undefined>) {
    for (const [id, parentId] of parentById) {
      if (!parentId) {
        continue
      }
      const children = this.childrenByParent.get(parentId) ?? []
      children.push(id)
      this.childrenByParent.set(parentId, children)
    }
  }

  has(id: string): boolean {
    return this.parentById.has(id)
  }

  close(seeds: readonly string[]): Set<string> {
    const closed = new Set<string>()
    const stack = [...seeds]
    while (stack.length > 0) {
      const id = stack.pop()
      if (!id || closed.has(id) || !this.parentById.has(id)) {
        continue
      }
      closed.add(id)
      const children = this.childrenByParent.get(id)
      if (!children) {
        continue
      }
      for (const child of children) {
        stack.push(child)
      }
    }
    return closed
  }

  assertParentDoesNotCycle(nodeId: string | undefined, parentId: string | undefined): void {
    if (!parentId) {
      return
    }
    if (nodeId && parentId === nodeId) {
      throw new APIError(SCOPE_CYCLE_ERROR, 400)
    }
    if (!this.parentById.has(parentId)) {
      throw new APIError(SCOPE_CYCLE_ERROR, 400)
    }

    const seen = new Set<string>()
    let current: string | undefined = parentId
    let depth = 0
    while (current) {
      if ((nodeId && current === nodeId) || seen.has(current) || depth >= MAX_SCOPE_DEPTH) {
        throw new APIError(SCOPE_CYCLE_ERROR, 400)
      }
      seen.add(current)
      depth += 1
      current = this.parentById.get(current)
    }
  }
}

export function parentMap(
  nodes: ReadonlyMap<string, { parentId?: string }>,
): Map<string, string | undefined> {
  const parents = new Map<string, string | undefined>()
  for (const [id, node] of nodes) {
    parents.set(id, node.parentId)
  }
  return parents
}
