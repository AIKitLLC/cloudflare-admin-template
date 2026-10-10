import type { RequestAuditMetadata } from '../types'

type HeaderSource = {
  get(name: string): string | null
}

type ActorLike = {
  id?: unknown
  email?: unknown
}

/**
 * Cloudflare sets `cf-connecting-ip` to the real client. Prefer it over
 * `x-forwarded-for`, which a caller can spoof before the edge overwrites it.
 */
export function readClientIp(headers: HeaderSource | null | undefined): string | null {
  const cloudflareIp = header(headers, 'cf-connecting-ip')
  if (cloudflareIp) return cloudflareIp

  const forwarded = header(headers, 'x-forwarded-for')
  if (forwarded) {
    const firstHop = forwarded.split(',')[0]?.trim()
    if (firstHop) return firstHop
  }

  return header(headers, 'x-real-ip')
}

export function readUserAgent(headers: HeaderSource | null | undefined): string | null {
  return header(headers, 'user-agent')
}

export function readRequestMetadata(req: {
  user?: ActorLike | null
  headers?: HeaderSource
}): RequestAuditMetadata {
  const id = req.user?.id
  const hasId = id !== undefined && id !== null && id !== ''
  const email = typeof req.user?.email === 'string' && req.user.email.length > 0 ? req.user.email : null

  return {
    actorId: hasId ? String(id) : null,
    actorRelationshipId: typeof id === 'number' || typeof id === 'string' ? id : null,
    actorEmail: email,
    ipAddress: readClientIp(req.headers),
    userAgent: readUserAgent(req.headers),
  }
}

function header(headers: HeaderSource | null | undefined, name: string): string | null {
  if (!headers || typeof headers.get !== 'function') return null
  const value = headers.get(name)
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
