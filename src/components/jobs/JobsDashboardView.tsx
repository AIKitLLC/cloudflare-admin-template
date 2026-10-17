import type { AdminViewServerProps } from 'payload'
import { DefaultTemplate } from '@payloadcms/next/templates'
import { Gutter } from '@payloadcms/ui'
import React from 'react'

import { evaluateCollectionAccess } from '../../access/evaluate-collection-access'
import { isAccessGranted } from '../../access/result'
import { loadUserGrants } from '../../access/resolve/load-user-grants'
import { evaluateJobDispatch } from '../../jobs/auth/evaluate-job-dispatch'
import { JOBS_SLUG } from '../../jobs/constants'
import { listJobDefinitions } from '../../jobs/registry/job-registry'
import { JobsDashboard, type JobMonitorRow } from './JobsDashboard'

export async function JobsDashboardView({
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
          collectionSlug: JOBS_SLUG,
          action: 'read',
        }),
      )
    : false
  const canTrigger = req.user ? await evaluateJobDispatch(req, 'trigger') : false
  const canRetry = req.user ? await evaluateJobDispatch(req, 'retry') : false
  const grants = req.user ? await loadUserGrants(req) : null
  const jobNames = listJobDefinitions()
    .filter((job) => !job.name.startsWith('test.'))
    .filter((job) => {
      if (!canTrigger) {
        return false
      }
      if (job.requiresFullAccess) {
        return grants?.fullAccess === true
      }
      if (job.permissionKey) {
        return grants?.fullAccess === true || grants?.permissionKeys.has(job.permissionKey) === true
      }
      return true
    })
    .map((job) => job.name)
  const result = canRead
    ? await req.payload.find({
        collection: JOBS_SLUG,
        depth: 0,
        limit: 50,
        overrideAccess: false,
        req,
        sort: '-createdAt',
      })
    : undefined

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
        <JobsDashboard
          apiRoute={req.payload.config.routes.api}
          canRead={canRead}
          canRetry={canRetry}
          canTrigger={canTrigger}
          jobNames={jobNames}
          jobs={(result?.docs ?? []) as JobMonitorRow[]}
        />
      </Gutter>
    </DefaultTemplate>
  )
}
