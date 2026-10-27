import { createLocalReq, type Payload } from 'payload'

import { loadUserGrants } from '../access'
import {
  NEXUS_IDENTITY_HEADER,
  NEXUS_IDENTITY_LIFETIME_MS,
  signNexusIdentity,
} from './bridge-identity'
import { nexusRoleFor } from './permissions'

export type NexusServices = {
  payload: Payload
  /** The `NEXUS` service binding; undefined when Nexus CRM is not installed. */
  nexus: Fetcher | undefined
  secret: string | undefined
}

/** Nexus paths the template forwards. Nexus's own sign-in (`/api/auth/*`) is never reachable. */
const FORWARDED = /^\/api\/nexus\/(v1\/.+|health)$/
const READ_METHODS = new Set(['GET', 'HEAD'])
const FORWARDED_HEADERS = ['accept', 'content-type']

const json = (status: number, message: string) =>
  Response.json(
    { errors: [{ message }] },
    { status, headers: { 'Cache-Control': 'private, no-store' } },
  )

/**
 * `/api/nexus/*` → the Nexus CRM Worker over its service binding. The caller is authenticated by
 * Payload (session cookie or `Authorization: JWT`), mapped to a Nexus role from its template grants,
 * and forwarded with a signed identity header instead of its own cookies or token.
 */
export function createNexusRoute({ getServices }: { getServices: () => Promise<NexusServices> }) {
  return async function handle(request: Request): Promise<Response> {
    const { payload, nexus, secret } = await getServices()
    const url = new URL(request.url)
    if (!nexus || !secret) return json(404, 'Nexus CRM is not installed.')
    if (!FORWARDED.test(url.pathname)) return json(404, 'Not Found')

    const { user } = await payload.auth({ headers: request.headers })
    if (!user) return json(401, 'You are not allowed to perform this action.')
    const write = !READ_METHODS.has(request.method)
    const origin = request.headers.get('origin')
    if (write && origin !== null && origin !== url.origin) {
      return json(403, 'You are not allowed to perform this action.')
    }
    const req = await createLocalReq({ user }, payload)
    const role = nexusRoleFor(await loadUserGrants(req))
    if (!role || (write && role === 'viewer')) {
      return json(403, 'You are not allowed to perform this action.')
    }

    const headers = new Headers()
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }
    headers.set(
      NEXUS_IDENTITY_HEADER,
      await signNexusIdentity(
        {
          userId: String(user.id),
          email: String(user.email),
          role,
          exp: Date.now() + NEXUS_IDENTITY_LIFETIME_MS,
        },
        secret,
      ),
    )
    const upstream = await nexus.fetch(
      `https://nexus.internal${url.pathname.replace(/^\/api\/nexus/, '/api')}${url.search}`,
      {
        method: request.method,
        headers,
        body: write ? await request.arrayBuffer() : undefined,
      },
    )
    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.delete('set-cookie')
    responseHeaders.set('Cache-Control', 'private, no-store')
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  }
}
