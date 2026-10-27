import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { loadUserGrants } from '../access'
import {
  NEXUS_IDENTITY_HEADER,
  NEXUS_IDENTITY_LIFETIME_MS,
  signNexusIdentity,
  signNexusLookup,
  type NexusRole,
} from './bridge-identity'
import { nexusRoleFor } from './permissions'
import { allowedWorkspaces, chooseWorkspace, workspaceForSlug, type NexusWorkspace } from './workspaces'

export type NexusServices = {
  payload: Payload
  /** The `NEXUS` service binding; undefined when Nexus CRM is not installed. */
  nexus: Fetcher | undefined
  secret: string | undefined
}

type Options = { getServices: () => Promise<NexusServices> }

/** Nexus API paths the template forwards. Nexus's own sign-in (`/api/auth/login`, `logout`) is never reachable. */
const FORWARDED = /^\/api\/nexus\/(v1\/.+|health|auth\/me)$/
const READ_METHODS = new Set(['GET', 'HEAD'])
const FORWARDED_HEADERS = ['accept', 'content-type']
const MCP_HEADERS = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id']
const DENIED = 'You are not allowed to perform this action.'
const NEXUS_ORIGIN = 'https://nexus.internal'
/** Nexus's own policy, applied here too: its HTML and assets come from its asset store, which sets none. */
const NEXUS_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'"

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
const error = (status: number, message: string) => json(status, { errors: [{ message }] })

type Caller = {
  req: PayloadRequest
  user: { id: number | string; email?: unknown }
  role: NexusRole
  workspaces: NexusWorkspace[]
}

/** The signed-in template user with a Nexus role and at least one workspace, or the refusal. */
async function authorize(request: Request, payload: Payload): Promise<Caller | 'anonymous' | 'denied'> {
  const { user } = await payload.auth({ headers: request.headers })
  if (!user) return 'anonymous'
  const req = await createLocalReq({ user }, payload)
  const grants = await loadUserGrants(req)
  const role = nexusRoleFor(grants)
  if (!role) return 'denied'
  const workspaces = await allowedWorkspaces(req, grants?.fullAccess === true)
  return workspaces.length === 0 ? 'denied' : { req, user, role, workspaces }
}

function requestedOrg(request: Request): string | undefined {
  const header = request.headers.get('x-nexus-org')
  if (header) return header
  const cookie = request.headers.get('cookie') ?? ''
  const match = /(?:^|;\s*)nexus_org=([^;]+)/.exec(cookie)
  return match ? decodeURIComponent(match[1]) : undefined
}

function identity(caller: Pick<Caller, 'user' | 'role'>, workspace: NexusWorkspace, secret: string) {
  return signNexusIdentity(
    {
      userId: String(caller.user.id),
      email: String(caller.user.email),
      role: caller.role,
      workspace: { key: workspace.key, name: workspace.name },
      exp: Date.now() + NEXUS_IDENTITY_LIFETIME_MS,
    },
    secret,
  )
}

function copyHeaders(request: Request, names: string[]): Headers {
  const headers = new Headers()
  for (const name of names) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

/** Nexus's answer without its cookies or host-wide HSTS, and with a template-relative redirect. */
function relay(upstream: Response, extra: Record<string, string>): Response {
  const headers = new Headers(upstream.headers)
  headers.delete('set-cookie')
  headers.delete('strict-transport-security')
  const location = headers.get('location')
  if (location?.startsWith(NEXUS_ORIGIN)) headers.set('location', `/nexus${location.slice(NEXUS_ORIGIN.length)}`)
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  return new Response(upstream.body, { status: upstream.status, headers })
}

/**
 * `/api/nexus/*` → the Nexus CRM Worker over its service binding. The caller is authenticated by
 * Payload (session cookie or `Authorization: JWT`), mapped to a Nexus role from its template grants
 * and to the workspace of one of its organizations, and forwarded with a signed identity header
 * instead of its own cookies or token. `/api/nexus/workspaces` is answered here. `/api/nexus/mcp`
 * is the MCP endpoint (see `handleMcp`).
 */
export function createNexusRoute({ getServices }: Options) {
  return async function handle(request: Request): Promise<Response> {
    const { payload, nexus, secret } = await getServices()
    const url = new URL(request.url)
    if (!nexus || !secret) return error(404, 'Nexus CRM is not installed.')
    if (url.pathname === '/api/nexus/mcp') return handleMcp(request, payload, nexus, secret)
    const workspacesPath = url.pathname === '/api/nexus/workspaces'
    if (!workspacesPath && !FORWARDED.test(url.pathname)) return error(404, 'Not Found')

    const write = !READ_METHODS.has(request.method)
    if ((workspacesPath || url.pathname === '/api/nexus/auth/me') && write) return error(405, 'Method Not Allowed')
    const origin = request.headers.get('origin')
    if (write && origin !== null && origin !== url.origin) return error(403, DENIED)
    const caller = await authorize(request, payload)
    if (caller === 'anonymous') return error(401, DENIED)
    if (caller === 'denied' || (write && caller.role === 'viewer')) return error(403, DENIED)
    const workspace = chooseWorkspace(caller.workspaces, requestedOrg(request))!
    if (workspacesPath) {
      return json(200, {
        items: caller.workspaces.map((item) => ({
          orgId: item.orgId,
          name: item.name,
          active: item.key === workspace.key,
        })),
      })
    }

    const headers = copyHeaders(request, FORWARDED_HEADERS)
    headers.set(NEXUS_IDENTITY_HEADER, await identity(caller, workspace, secret))
    const upstream = await nexus.fetch(
      `${NEXUS_ORIGIN}${url.pathname.replace(/^\/api\/nexus/, '/api')}${url.search}`,
      { method: request.method, headers, body: write ? await request.arrayBuffer() : undefined },
    )
    return relay(upstream, { 'Cache-Control': 'private, no-store' })
  }
}

/**
 * MCP clients send a Nexus token (`Authorization: Bearer nxmcp_…`), not a template session. The
 * template asks Nexus, over the binding only, whose token it is, then checks that user's current
 * template grants and organization scope, and forwards the call with a signed identity. Nexus refuses
 * the token without that identity, so removing a user's grants in the template stops their tokens
 * on the next call.
 */
async function handleMcp(request: Request, payload: Payload, nexus: Fetcher, secret: string): Promise<Response> {
  const unauthorized = () =>
    Response.json(
      { error: 'Valid Nexus MCP bearer token with crm:read is required' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="Nexus CRM MCP"', 'Cache-Control': 'no-store' } },
    )
  const authorization = request.headers.get('authorization') ?? ''
  if (!authorization.startsWith('Bearer ')) return unauthorized()
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authorization.slice(7).trim()))
  const tokenHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const lookup = await nexus.fetch(`${NEXUS_ORIGIN}/api/bridge/mcp-token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-nexus-lookup': await signNexusLookup(tokenHash, Date.now() + NEXUS_IDENTITY_LIFETIME_MS, secret),
    },
    body: JSON.stringify({ tokenHash }),
  })
  if (lookup.status !== 200) return unauthorized()
  const owner = (await lookup.json()) as { email: string; workspaceSlug: string }

  const { docs } = await payload.find({
    collection: 'users',
    where: { email: { equals: owner.email } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const user = docs[0] as Caller['user'] | undefined
  if (!user) return unauthorized()
  const req = await createLocalReq({ user: { ...user, collection: 'users' } as never }, payload)
  const grants = await loadUserGrants(req)
  const role = nexusRoleFor(grants)
  if (role !== 'owner' && role !== 'admin') return unauthorized()
  const workspace = workspaceForSlug(await allowedWorkspaces(req, grants?.fullAccess === true), owner.workspaceSlug)
  if (!workspace) return unauthorized()

  const headers = copyHeaders(request, MCP_HEADERS)
  headers.set('authorization', authorization)
  headers.set(NEXUS_IDENTITY_HEADER, await identity({ user, role }, workspace, secret))
  const upstream = await nexus.fetch(`${NEXUS_ORIGIN}/mcp`, {
    method: request.method,
    headers,
    body: READ_METHODS.has(request.method) ? undefined : await request.arrayBuffer(),
  })
  return relay(upstream, { 'Cache-Control': 'no-store' })
}

/**
 * `/nexus/*` → the Nexus SPA (built with `--base /nexus/`) from the Nexus Worker's asset store. The
 * page needs a template session and a Nexus role; without a session it redirects to the admin login.
 */
export function createNexusAppRoute({ getServices }: Options) {
  return async function handle(request: Request): Promise<Response> {
    const { payload, nexus, secret } = await getServices()
    if (!nexus || !secret) return new Response('Not Found', { status: 404 })
    const url = new URL(request.url)
    const caller = await authorize(request, payload)
    if (caller === 'anonymous') {
      const redirect = encodeURIComponent(`${url.pathname}${url.search}`)
      return new Response(null, { status: 302, headers: { location: `/admin/login?redirect=${redirect}` } })
    }
    if (caller === 'denied') return new Response(DENIED, { status: 403 })
    const path = url.pathname.replace(/^\/nexus/, '') || '/'
    const upstream = await nexus.fetch(`${NEXUS_ORIGIN}${path}${url.search}`, {
      method: request.method,
      headers: copyHeaders(request, ['accept', 'if-none-match']),
    })
    return relay(upstream, {
      'Content-Security-Policy': NEXUS_CSP,
      'Cache-Control': path.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
  }
}
