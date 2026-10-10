// @vitest-environment node
import { GRAPHQL_POST, REST_GET, REST_POST } from '@payloadcms/next/routes'
import { getPayload, type CollectionSlug, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { defineJob } from '@/jobs/registry/define-job'
import { JOB_NOT_FOUND_MESSAGE, RETRY_ONLY_FAILED_MESSAGE, UNKNOWN_JOB_MESSAGE } from '@/jobs/errors'
import { processJob } from '@/jobs/runner/process-job'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/rbac/guards/privilege-context'
import { setRoleGrant } from '@/rbac/matrix/set-role-grant'

const ORIGIN = 'http://localhost:3000'
const post = REST_POST(config)
const get = REST_GET(config)
const graphql = GRAPHQL_POST(config)

let payload: Payload
const stamp = Date.now()
const createdUserIds: Array<number | string> = []
const createdRoleIds: Array<number | string> = []
const createdJobIds: Array<number | string> = []

defineJob({
  name: 'test.echo',
  maxAttempts: 2,
  validate(input: unknown): { message: string } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('message is required.')
    }
    const message = (input as { message?: unknown }).message
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('message is required.')
    }
    return { message }
  },
  async execute() {
    return undefined
  },
})

defineJob({
  name: 'test.boom',
  maxAttempts: 1,
  validate(input: unknown) {
    return input ?? {}
  },
  async execute() {
    throw new Error('boom')
  },
})

describe('job HTTP permissions', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
  }, 120000)

  afterAll(async () => {
    if (!payload) return
    if (createdJobIds.length > 0) {
      await payload.delete({
        collection: 'jobs' as CollectionSlug,
        where: { id: { in: createdJobIds } },
        overrideAccess: true,
      })
    }
    if (createdUserIds.length > 0) {
      await payload.delete({
        collection: 'users',
        where: { id: { in: createdUserIds } },
        overrideAccess: true,
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
    }
    if (createdRoleIds.length > 0) {
      await payload.delete({
        collection: 'role-permissions' as CollectionSlug,
        where: { role: { in: createdRoleIds } },
        overrideAccess: true,
      })
      await payload.delete({
        collection: 'roles' as CollectionSlug,
        where: { id: { in: createdRoleIds } },
        overrideAccess: true,
      })
    }
  }, 120000)

  it('refuses anonymous and read-only callers, and allows a trigger grant to enqueue a registered job', async () => {
    const anonymous = await get(jsonRequest('/api/jobs', undefined, undefined, ORIGIN, 'GET'), route(['jobs']))
    expect(anonymous.status).toBe(403)

    const reader = await loginWith(['jobs:read'])
    const listed = await get(jsonRequest('/api/jobs', undefined, reader, ORIGIN, 'GET'), route(['jobs']))
    expect(listed.status).toBe(200)

    const refusedTrigger = await post(
      jsonRequest('/api/jobs/trigger', { name: 'test.echo', payload: { message: 'hi' } }, reader),
      route(['jobs', 'trigger']),
    )
    expect(refusedTrigger.status).toBe(403)

    const trigger = await loginWith(['jobs:trigger'])
    const created = await post(
      jsonRequest('/api/jobs/trigger', { name: 'test.echo', payload: { message: 'hi' } }, trigger),
      route(['jobs', 'trigger']),
    )
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as { doc?: { id?: number; status?: string; payload?: { message?: string } } }
    expect(createdBody.doc?.status).toBe('PENDING')
    expect(createdBody.doc?.payload?.message).toBe('hi')
    if (createdBody.doc?.id) createdJobIds.push(createdBody.doc.id)

    const restCreate = await post(
      jsonRequest('/api/jobs', { name: 'test.echo', payload: { message: 'rest' } }, trigger),
      route(['jobs']),
    )
    expect(restCreate.status).toBeLessThan(300)
    const restBody = (await restCreate.json()) as { doc?: { id?: number } }
    if (restBody.doc?.id) createdJobIds.push(restBody.doc.id)

    const unknown = await post(
      jsonRequest('/api/jobs/trigger', { name: 'not.registered', payload: {} }, trigger),
      route(['jobs', 'trigger']),
    )
    expect(unknown.status).toBe(400)
    expect(JSON.stringify(await unknown.json())).toContain(UNKNOWN_JOB_MESSAGE)

    const invalid = await post(
      jsonRequest('/api/jobs/trigger', { name: 'test.echo', payload: {} }, trigger),
      route(['jobs', 'trigger']),
    )
    expect(invalid.status).toBe(400)
    expect(JSON.stringify(await invalid.json())).toContain('message is required.')

    const graphqlUnknown = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `mutation Create($name: String!) {
            createJob(data: { name: $name, payload: {} }) { id }
          }`,
          variables: { name: 'not.registered' },
        },
        trigger,
      ),
    )
    expect(JSON.stringify(await graphqlUnknown.json())).toContain(UNKNOWN_JOB_MESSAGE)

    const graphqlInvalid = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `mutation Create($name: String!) {
            createJob(data: { name: $name, payload: {} }) { id }
          }`,
          variables: { name: 'test.echo' },
        },
        trigger,
      ),
    )
    expect(JSON.stringify(await graphqlInvalid.json())).toContain('message is required.')

    const graphqlCreated = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `mutation Create($name: String!, $payload: JSON!) {
            createJob(data: { name: $name, payload: $payload }) { id status }
          }`,
          variables: { name: 'test.echo', payload: { message: 'gql' } },
        },
        trigger,
      ),
    )
    const graphqlBody = await graphqlCreated.json()
    expect(JSON.stringify(graphqlBody)).toContain('PENDING')
    const graphqlId = (graphqlBody as { data?: { createJob?: { id?: number } } }).data?.createJob?.id
    if (graphqlId) createdJobIds.push(graphqlId)

    const deniedList = await graphql(
      jsonRequest('/api/graphql', { query: 'query { Jobs { docs { id } } }' }, trigger),
    )
    expect(deniedList.status).toBe(200)
    expect(JSON.stringify(await deniedList.json())).toMatch(/not allowed|forbidden|unauthorized/i)
  })

  it('gates retry on the retry permission and refuses jobs that are not failed', async () => {
    const trigger = await loginWith(['jobs:trigger'])
    const queued = await post(
      jsonRequest('/api/jobs/trigger', { name: 'test.boom', payload: {} }, trigger),
      route(['jobs', 'trigger']),
    )
    expect(queued.status).toBe(201)
    const queuedBody = (await queued.json()) as { doc?: { id?: number } }
    const jobId = Number(queuedBody.doc?.id)
    createdJobIds.push(jobId)

    const reader = await loginWith(['jobs:read'])
    const earlyRetry = await post(
      jsonRequest(`/api/jobs/${jobId}/retry`, {}, reader),
      route(['jobs', String(jobId), 'retry']),
    )
    expect(earlyRetry.status).toBe(403)

    await processJob(payload, jobId)
    const failed = await payload.findByID({
      collection: 'jobs' as CollectionSlug,
      id: jobId,
      depth: 0,
      overrideAccess: true,
    })
    expect((failed as { status?: string }).status).toBe('FAILED')

    const stillPendingRetry = await post(
      jsonRequest(`/api/jobs/${jobId}/retry`, {}, reader),
      route(['jobs', String(jobId), 'retry']),
    )
    expect(stillPendingRetry.status).toBe(403)

    const retryUser = await loginWith(['jobs:retry'])
    const retried = await post(
      jsonRequest(`/api/jobs/${jobId}/retry`, {}, retryUser),
      route(['jobs', String(jobId), 'retry']),
    )
    expect(retried.status).toBe(200)
    const retriedBody = (await retried.json()) as { doc?: { status?: string } }
    expect(retriedBody.doc?.status).toBe('PENDING')

    await processJob(payload, jobId)
    const succeeded = await payload.update({
      collection: 'jobs' as CollectionSlug,
      id: jobId,
      data: { status: 'SUCCESS' },
      overrideAccess: true,
      context: { jobSystemWrite: true, skipJobEnqueue: true },
    })
    expect((succeeded as { status?: string }).status).toBe('SUCCESS')

    const refusedSuccess = await post(
      jsonRequest(`/api/jobs/${jobId}/retry`, {}, retryUser),
      route(['jobs', String(jobId), 'retry']),
    )
    expect(refusedSuccess.status).toBe(400)
    expect(JSON.stringify(await refusedSuccess.json())).toContain(RETRY_ONLY_FAILED_MESSAGE)

    const missing = await post(
      jsonRequest('/api/jobs/999999/retry', {}, retryUser),
      route(['jobs', '999999', 'retry']),
    )
    expect(missing.status).toBe(404)
    expect(JSON.stringify(await missing.json())).toContain(JOB_NOT_FOUND_MESSAGE)

    const graphqlRetry = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `mutation Retry($id: Int!) { retryJob(id: $id) { id status } }`,
          variables: { id: jobId },
        },
        retryUser,
      ),
    )
    expect(JSON.stringify(await graphqlRetry.json())).toContain(RETRY_ONLY_FAILED_MESSAGE)

    const graphqlDenied = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `mutation Retry($id: Int!) { retryJob(id: $id) { id status } }`,
          variables: { id: jobId },
        },
        reader,
      ),
    )
    expect(JSON.stringify(await graphqlDenied.json())).toContain('not allowed to retry')
  })
})

function route(slug: string[]) {
  return { params: Promise.resolve({ slug }) }
}

function jsonRequest(
  path: string,
  body?: unknown,
  cookie?: string,
  origin = ORIGIN,
  method = 'POST',
): Request {
  const headers = new Headers({ origin })
  if (body !== undefined) {
    headers.set('content-type', 'application/json')
  }
  if (cookie) {
    headers.set('cookie', cookie)
  }
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function cookieHeader(response: Response): string {
  const cookies = response.headers.getSetCookie?.() ?? []
  const parts = cookies.length > 0 ? cookies : [response.headers.get('set-cookie') ?? '']
  return parts
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter((cookie) => cookie && cookie.includes('='))
    .join('; ')
}

async function loginWith(keys: string[]): Promise<string> {
  const role = await payload.create({
    collection: 'roles' as CollectionSlug,
    data: { name: `jobs-${stamp}-${createdRoleIds.length}`, slug: `jobs-${stamp}-${createdRoleIds.length}`, grantsFullAccess: false },
    overrideAccess: true,
  })
  createdRoleIds.push(role.id)
  for (const key of keys) {
    await setRoleGrant(payload, {
      roleId: role.id,
      permissionId: await permissionIdFor(key),
      granted: true,
    })
  }
  const email = `jobs-${stamp}-${createdUserIds.length}@example.com`
  const password = 'test-password-123'
  const user = await payload.create({
    collection: 'users',
    data: { email, password, roles: [role.id] },
    overrideAccess: true,
    context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
  })
  createdUserIds.push(user.id)
  const response = await post(jsonRequest('/api/users/login', { email, password }), route(['users', 'login']))
  expect(response.status).toBe(200)
  const cookie = cookieHeader(response)
  expect(cookie).toContain('payload-token=')
  return cookie
}

async function permissionIdFor(key: string): Promise<number> {
  const permission = await payload.find({
    collection: 'permissions' as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { key: { equals: key } },
  })
  if (!permission.docs[0]) {
    throw new Error(`Missing permission ${key}`)
  }
  return Number(permission.docs[0].id)
}
