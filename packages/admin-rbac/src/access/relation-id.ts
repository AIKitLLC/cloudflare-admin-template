export function relationId(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'string') {
    return String(value)
  }
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'number' || typeof id === 'string') {
      return String(id)
    }
  }
  return undefined
}

export function relationIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const id = relationId(item)
      return id ? [id] : []
    })
  }
  const id = relationId(value)
  return id ? [id] : []
}
