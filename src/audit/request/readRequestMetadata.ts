import type { RequestAuditMetadata } from '../types'

type HeaderSource = {
  get(name: string): string | null
}

type ActorLike = {
  id?: unknown
  email?: unknown
}

/**
 * Trusted client IP. Only `CF-Connecting-IP`, which Cloudflare sets at the edge.
 * `X-Forwarded-For` and `X-Real-IP` are caller-controlled and are never returned here.
 */
export function readTrustedClientIp(headers: HeaderSource | null | undefined): string | null {
  return header(headers, 'cf-connecting-ip')
}

/**
 * Untrusted hint from `X-Forwarded-For` (first hop) or `X-Real-IP`.
 * Stored separately so it cannot be mistaken for the trusted client IP.
 */
export function readUntrustedClientIp(headers: HeaderSource | null | undefined): string | null {
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
    ipAddress: readTrustedClientIp(req.headers),
    untrustedClientIp: readUntrustedClientIp(req.headers),
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
