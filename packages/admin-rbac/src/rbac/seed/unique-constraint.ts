export function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unique constraint failed/i.test(message) || /already exists/i.test(message)
}
