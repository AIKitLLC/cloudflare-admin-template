const SECRET_SEGMENTS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'secrets',
  'token',
  'tokens',
  'apikey',
  'credential',
  'credentials',
  'privatekey',
  'cookie',
  'session',
  'salt',
  'ssn',
  'otp',
  'pin',
  'authorization',
])

export function isSecretKey(key: string): boolean {
  const normalized = key.trim().toLowerCase()
  if (!normalized) {
    return false
  }
  const segments = normalized.split(/[^a-z0-9]+/).filter(Boolean)
  if (segments.some((segment) => SECRET_SEGMENTS.has(segment))) {
    return true
  }
  for (let index = 0; index < segments.length - 1; index += 1) {
    const pair = `${segments[index]}-${segments[index + 1]}`
    if (pair === 'api-key' || pair === 'access-key' || pair === 'private-key') {
      return true
    }
  }
  return false
}

export function findSecretKey(value: unknown, depth = 0): string | null {
  if (depth > 8 || !value || typeof value !== 'object') {
    return null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSecretKey(item, depth + 1)
      if (found) {
        return found
      }
    }
    return null
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      return key
    }
    const found = findSecretKey(nested, depth + 1)
    if (found) {
      return found
    }
  }
  return null
}
