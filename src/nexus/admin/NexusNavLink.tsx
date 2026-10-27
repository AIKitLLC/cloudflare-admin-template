import { getCloudflareContext } from '@opennextjs/cloudflare'
import { createLocalReq, type Payload } from 'payload'
import React from 'react'

import { loadUserGrants } from '../../access'
import { nexusRoleFor } from '../permissions'

type NexusNavLinkProps = {
  payload?: Payload
  user?: { id?: number | string; collection?: string } | null
}

/** Sidebar link to the Nexus CRM app: only while the NEXUS binding exists, and only for users with a Nexus role. */
export async function NexusNavLink({ payload, user }: NexusNavLinkProps) {
  if (!payload || !user?.id) return null
  const { env } = await getCloudflareContext({ async: true })
  if (!(env as { NEXUS?: unknown }).NEXUS) return null
  const req = await createLocalReq({ user: user as never }, payload)
  if (!nexusRoleFor(await loadUserGrants(req))) return null
  return (
    // A full page load on purpose: /nexus is the Nexus SPA behind a route handler, not a Next page.
    // eslint-disable-next-line @next/next/no-html-link-for-pages
    <a className="nexus-nav-link" href="/nexus">
      Nexus CRM
    </a>
  )
}
