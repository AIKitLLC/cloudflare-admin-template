import type { AdminViewServerProps } from 'payload'
import { DefaultTemplate } from '@payloadcms/next/templates'
import { Gutter } from '@payloadcms/ui'
import React from 'react'

import { ROLE_PERMISSIONS_SLUG } from '../../access/constants'
import { evaluateCollectionAccess } from '../../access/evaluate-collection-access'
import { isAccessGranted } from '../../access/result'
import { loadPermissionMatrix } from '../../rbac/matrix/load-permission-matrix'
import { PermissionMatrixEditor } from './PermissionMatrixEditor'

export async function PermissionMatrixView({
  initPageResult,
  params,
  searchParams,
  user,
}: AdminViewServerProps) {
  const req = initPageResult.req
  const canRead = req.user
    ? isAccessGranted(
        await evaluateCollectionAccess({
          req,
          collectionSlug: ROLE_PERMISSIONS_SLUG,
          action: 'read',
        }),
      )
    : false
  const canEdit =
    canRead &&
    isAccessGranted(
      await evaluateCollectionAccess({
        req,
        collectionSlug: ROLE_PERMISSIONS_SLUG,
        action: 'update',
      }),
    )
  const matrix = canRead ? await loadPermissionMatrix(req.payload) : undefined

  return (
    <DefaultTemplate
      i18n={initPageResult.req.i18n}
      locale={initPageResult.locale}
      params={params}
      payload={initPageResult.req.payload}
      permissions={initPageResult.permissions}
      searchParams={searchParams}
      user={user}
      visibleEntities={initPageResult.visibleEntities}
    >
      <Gutter>
        {matrix ? (
          <PermissionMatrixEditor
            apiRoute={req.payload.config.routes.api}
            canEdit={canEdit}
            matrix={matrix}
          />
        ) : (
          <div className="rbac-matrix">
            <h1>Permission matrix</h1>
            <p className="rbac-matrix__intro">
              You need permission to read role permissions before this matrix is available.
            </p>
          </div>
        )}
      </Gutter>
    </DefaultTemplate>
  )
}
