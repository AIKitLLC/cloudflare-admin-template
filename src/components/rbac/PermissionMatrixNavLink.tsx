import type { Payload, SanitizedPermissions } from 'payload'
import React from 'react'

type PermissionMatrixNavLinkProps = {
  payload?: Payload
  permissions?: SanitizedPermissions
  user?: { id?: number | string } | null
}

export function PermissionMatrixNavLink({
  payload,
  permissions,
  user,
}: PermissionMatrixNavLinkProps) {
  if (!user) {
    return null
  }
  if (permissions?.collections?.['role-permissions']?.read !== true) {
    return null
  }
  const adminRoute = payload?.config.routes.admin ?? '/admin'
  return (
    <a className="rbac-nav-link" href={`${adminRoute}/permission-matrix`}>
      Permission Matrix
    </a>
  )
}
