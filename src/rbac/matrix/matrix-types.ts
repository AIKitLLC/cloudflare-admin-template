export type MatrixRole = {
  id: number
  name: string
  slug: string
  grantsFullAccess: boolean
}

export type MatrixRow = {
  permissionId: number
  key: string
  label: string
  action: string
  fieldPath: string | null
  grantsByRoleId: Record<string, boolean>
}

export type MatrixGroup = {
  collectionSlug: string
  label: string
  rows: MatrixRow[]
}

export type PermissionMatrix = {
  roles: MatrixRole[]
  groups: MatrixGroup[]
}
