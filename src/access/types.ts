import type { PayloadRequest, Where } from 'payload'

import type { COLLECTION_ACTIONS, PERMISSION_ACTIONS } from './constants'

export type CollectionAction = (typeof COLLECTION_ACTIONS)[number]

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]

export type FieldAccessMode = 'read' | 'write'

export type AccessConstraint = boolean | Where

export type ScopeDimension = 'organization' | 'branch' | 'data-class'

/**
 * Opt a collection into row scope. Field names narrow records.
 * `dimension` scopes the scope-node collection itself.
 * `assignments` limits user reads, updates, and deletes to accounts inside the actor's scope, and enforces who may edit those assignments.
 */
export type RowScopeBinding = {
  organizationField?: string
  branchField?: string
  dataClassField?: string
  dimension?: ScopeDimension
  assignments?: boolean
}

export type RbacCollectionOptions = {
  enabled?: boolean
  anonymousRead?: boolean
  selfService?: boolean
  selfServiceFields?: string[]
  rowScope?: RowScopeBinding
}

export type UserGrants = {
  userId: number | string
  fullAccess: boolean
  permissionKeys: Set<string>
  roleIds: string[]
}

export type AccessEvaluationContext = {
  req: PayloadRequest
  collectionSlug: string
  action: CollectionAction
  grants: UserGrants | undefined
  options: RbacCollectionOptions
}

/**
 * A gate returns undefined to defer, false to deny, or an allow constraint.
 * Gates must stay stateless. Request data belongs on AccessEvaluationContext.
 */
export type AccessGate = {
  name: string
  evaluate: (context: AccessEvaluationContext) => Promise<AccessConstraint | undefined>
}

export type RowScopeContributor = (
  context: AccessEvaluationContext,
) => Promise<Where | undefined> | Where | undefined
