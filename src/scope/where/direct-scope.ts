/** Assignments stored on the user, before descendant closure. */
export type DirectScope = {
  organizationIds: readonly string[]
  branchIds: readonly string[]
  /** Organization that owns each directly assigned branch. Not ancestor or descendant orgs. */
  branchOrganizationIds: readonly string[]
  dataClassIds: readonly string[]
}
