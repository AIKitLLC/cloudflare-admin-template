import type { PayloadRequest } from 'payload'

import { loadEffectiveScope, ORGANIZATIONS_SLUG } from '../scope'

/**
 * A Nexus workspace a template user may open: one per organization, plus the installation default.
 * The key carries the organization's creation time, so an organization created later under a
 * reused id (SQLite reuses the id of a deleted row) never inherits an older workspace.
 */
export type NexusWorkspace = {
  key: string
  name: string
  orgId: number | null
}

export const DEFAULT_WORKSPACE: NexusWorkspace = { key: 'default', name: 'Default workspace', orgId: null }

type OrganizationDoc = { id: number; name: string; createdAt: string }

/**
 * Full access: every organization and the default workspace. Otherwise the organizations the user
 * was assigned, with their descendants (`grantableOrganizationIds`: a branch assignment alone does
 * not open its organization's CRM). A user with no organization or branch assignment gets the
 * default workspace, so installs that do not use organizations keep working.
 */
export async function allowedWorkspaces(
  req: PayloadRequest,
  fullAccess: boolean,
): Promise<NexusWorkspace[]> {
  let ids: string[] | undefined
  if (!fullAccess) {
    const scope = await loadEffectiveScope(req)
    if (scope.grantableOrganizationIds.size === 0) {
      return scope.organizationIds.size === 0 ? [DEFAULT_WORKSPACE] : []
    }
    ids = [...scope.grantableOrganizationIds]
  }
  // ponytail: one page of 1000 organizations; paginate if an install ever has more.
  const { docs } = await req.payload.find({
    collection: ORGANIZATIONS_SLUG,
    where: ids ? { id: { in: ids } } : {},
    sort: 'name',
    limit: 1000,
    depth: 0,
    overrideAccess: true,
  })
  const organizations = (docs as unknown as OrganizationDoc[]).map(
    (doc): NexusWorkspace => ({
      key: `org_${doc.id}_${Date.parse(doc.createdAt)}`,
      name: doc.name.slice(0, 120) || `Organization ${doc.id}`,
      orgId: doc.id,
    }),
  )
  return fullAccess ? [DEFAULT_WORKSPACE, ...organizations] : organizations
}

/** The requested workspace (`default` or an organization id) when allowed, else the first allowed one. */
export function chooseWorkspace(
  allowed: NexusWorkspace[],
  requested: string | undefined,
): NexusWorkspace | undefined {
  const match = allowed.find((workspace) =>
    requested === 'default' ? workspace.orgId === null : String(workspace.orgId) === requested,
  )
  return match ?? allowed[0]
}

/** The workspace an MCP token belongs to (its Nexus slug), when still allowed. */
export function workspaceForSlug(
  allowed: NexusWorkspace[],
  slug: string,
): NexusWorkspace | undefined {
  return /^org_\d+_\d+$/.test(slug)
    ? allowed.find((workspace) => workspace.key === slug)
    : allowed.find((workspace) => workspace.orgId === null)
}
