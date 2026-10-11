import type { Payload, SanitizedPermissions } from 'payload'
import React from 'react'

type JobsNavLinkProps = {
  payload?: Payload
  permissions?: SanitizedPermissions
  user?: { id?: number | string } | null
}

export function JobsNavLink({ payload, permissions, user }: JobsNavLinkProps) {
  if (!user || permissions?.collections?.jobs?.read !== true) {
    return null
  }
  const adminRoute = payload?.config.routes.admin ?? '/admin'
  return (
    <a className="jobs-nav-link" href={`${adminRoute}/job-monitor`}>
      Job Monitor
    </a>
  )
}
