import { createHash } from 'crypto'

export function scopeIdempotencyKey(
  userId: number | string,
  jobName: string,
  clientKey: string,
): string {
  const scoped = `job:${userId}:${jobName}:${clientKey}`
  if (scoped.length <= 200) {
    return scoped
  }
  return `job:${createHash('sha256').update(scoped).digest('hex')}`
}

export function isScopedIdempotencyKey(value: string): boolean {
  return value.startsWith('job:')
}

export function sameJobPayload(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
