/**
 * Drops an assignment whose ancestor is also assigned.
 * The parent already covers that node and every descendant.
 */
export function collapseCoveredIds(
  ids: readonly string[],
  parentById: ReadonlyMap<string, string | undefined>,
): string[] {
  const selected = new Set(ids.filter((id) => id.length > 0))
  return [...selected].filter((id) => !ancestorIsSelected(id, selected, parentById))
}

function ancestorIsSelected(
  id: string,
  selected: ReadonlySet<string>,
  parentById: ReadonlyMap<string, string | undefined>,
): boolean {
  const seen = new Set<string>()
  let parent = parentById.get(id)
  while (parent && !seen.has(parent)) {
    if (selected.has(parent)) {
      return true
    }
    seen.add(parent)
    parent = parentById.get(parent)
  }
  return false
}
