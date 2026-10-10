export type ScopeNode = {
  id: string
  parentId?: string
}

export type BranchNode = ScopeNode & {
  organizationId?: string
}

export type ScopeCatalog = {
  organizations: Map<string, ScopeNode>
  branches: Map<string, BranchNode>
  dataClasses: Map<string, ScopeNode>
}

export type ScopeAssignments = {
  organizationIds: string[]
  branchIds: string[]
  dataClassIds: string[]
}

export type EffectiveScope = {
  /** Organizations used to match records, including the org that owns an assigned branch. */
  organizationIds: ReadonlySet<string>
  /** Organizations the user was assigned, plus descendants. Implied branch orgs are excluded. */
  grantableOrganizationIds: ReadonlySet<string>
  branchIds: ReadonlySet<string>
  dataClassIds: ReadonlySet<string>
}
