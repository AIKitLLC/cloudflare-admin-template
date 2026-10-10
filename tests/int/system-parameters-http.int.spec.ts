// @vitest-environment node
import { GRAPHQL_POST, REST_DELETE, REST_GET, REST_PATCH, REST_POST } from '@payloadcms/next/routes'
import { getPayload, type CollectionSlug, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/rbac/guards/privilege-context'
import { setRoleGrant } from '@/rbac/matrix/set-role-grant'
import {
  createIsolateMemory,
  ParameterReadCache,
} from '@/system-parameters/cache/parameter-read-cache'
import { createPayloadVersionStore } from '@/system-parameters/cache/version-store'
import {
  PARAMETER_CACHE_MAX_AGE_MS,
  PARAMETER_CACHE_VERIFY_TTL_MS,
  REDACTED_PARAMETER_VALUE,
} from '@/system-parameters/constants'
import { loadParameter } from '@/system-parameters/read/load-parameter'
import { getParameter, ParameterTypeMismatchError } from '@/system-parameters/read/get-parameter'
import { readSystemParameterAudit } from '@/system-parameters/sensitive/audit-view'
import { SYSTEM_PARAMETERS_SLUG } from '@/system-parameters/constants'
import {
  PARAMETER_BOOLEAN_VALUE_ERROR,
  PARAMETER_JSON_SHAPE_ERROR,
  PARAMETER_JSON_SYNTAX_ERROR,
  PARAMETER_KEY_FORMAT_ERROR,
  PARAMETER_NUMBER_VALUE_ERROR,
  PARAMETER_SECRET_KEY_ERROR,
  PARAMETER_STRING_VALUE_ERROR,
  PARAMETER_UNMASK_VALUE_ERROR,
  PARAMETER_VALUE_QUERY_ERROR,
} from '@/system-parameters/validation/messages'

const ORIGIN = 'http://localhost:3000'
const post = REST_POST(config)
const patch = REST_PATCH(config)
const get = REST_GET(config)
const remove = REST_DELETE(config)
const graphql = GRAPHQL_POST(config)

let payload: Payload
const stamp = Date.now()
const createdUserIds: Array<number | string> = []
const createdRoleIds: Array<number | string> = []
const createdParameterIds: Array<number | string> = []

describe('system parameters over HTTP', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
  }, 120000)

  afterAll(async () => {
    if (!payload) return
    if (createdParameterIds.length > 0) {
      await payload.delete({
        collection: SYSTEM_PARAMETERS_SLUG,
        where: { id: { in: createdParameterIds } },
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
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
      await payload.delete({
        collection: 'roles' as CollectionSlug,
        where: { id: { in: createdRoleIds } },
        overrideAccess: true,
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
    }
  }, 120000)

  it('rejects bad types and secret-like keys on REST and GraphQL', async () => {
    const cookie = await superAdminCookie()
    const category = 'operations'

    const uppercase = await post(
      jsonRequest(
        '/api/system-parameters',
        {
          key: `Feature-Flag-${stamp}`,
          category,
          valueType: 'string',
          value: 'x',
        },
        cookie,
      ),
      route(['system-parameters']),
    )
    expect(uppercase.status).toBe(400)
    expect(JSON.stringify(await uppercase.json())).toContain(PARAMETER_KEY_FORMAT_ERROR)

    const secretKey = await post(
      jsonRequest(
        '/api/system-parameters',
        {
          key: `stripe-secret-${stamp}`,
          category,
          valueType: 'string',
          value: 'sk_live_should_not_store',
        },
        cookie,
      ),
      route(['system-parameters']),
    )
    expect(secretKey.status).toBe(400)
    expect(JSON.stringify(await secretKey.json())).toContain(PARAMETER_SECRET_KEY_ERROR)

    const numberAsString = await post(
      jsonRequest(
        '/api/system-parameters',
        {
          key: `retries-${stamp}`,
          category,
          valueType: 'number',
          value: '12',
        },
        cookie,
      ),
      route(['system-parameters']),
    )
    expect(numberAsString.status).toBe(400)
    expect(JSON.stringify(await numberAsString.json())).toContain(PARAMETER_NUMBER_VALUE_ERROR)

    const booleanAsString = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `mutation Create($key: String!, $category: String!, $valueType: SystemParameter_valueType_MutationInput!, $value: JSON!) {
          createSystemParameter(data: { key: $key, category: $category, valueType: $valueType, value: $value }) { id }
        }`,
          variables: {
            key: `flag-${stamp}`,
            category,
            valueType: 'boolean',
            value: 'true',
          },
        },
        cookie,
      ),
    )
    expect(JSON.stringify(await booleanAsString.json())).toContain(PARAMETER_BOOLEAN_VALUE_ERROR)

    const badJson = await post(
      jsonRequest(
        '/api/system-parameters',
        {
          key: `flags-${stamp}`,
          category,
          valueType: 'json',
          value: '{not json',
        },
        cookie,
      ),
      route(['system-parameters']),
    )
    expect(badJson.status).toBe(400)
    expect(JSON.stringify(await badJson.json())).toContain(PARAMETER_JSON_SYNTAX_ERROR)

    const jsonPrimitive = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `mutation Create($key: String!, $category: String!, $valueType: SystemParameter_valueType_MutationInput!, $value: JSON!) {
          createSystemParameter(data: { key: $key, category: $category, valueType: $valueType, value: $value }) { id }
        }`,
          variables: {
            key: `json-primitive-${stamp}`,
            category,
            valueType: 'json',
            value: 12,
          },
        },
        cookie,
      ),
    )
    expect(JSON.stringify(await jsonPrimitive.json())).toContain(PARAMETER_JSON_SHAPE_ERROR)

    const zero = await createOverRest(cookie, {
      key: `max-retries-${stamp}`,
      category,
      valueType: 'number',
      value: 0,
    })
    expect(zero.value).toBe(0)

    const disabled = await createOverRest(cookie, {
      key: `maintenance-mode-${stamp}`,
      category,
      valueType: 'boolean',
      value: false,
    })
    expect(disabled.value).toBe(false)

    const blank = await createOverRest(cookie, {
      key: `banner-${stamp}`,
      category,
      valueType: 'string',
      value: '',
    })
    expect(blank.value).toBe('')

    const parsed = await createOverRest(cookie, {
      key: `feature-flags-${stamp}`,
      category: 'features',
      valueType: 'json',
      value: '{"checkout":true}',
    })
    expect(parsed.value).toEqual({ checkout: true })

    const duplicate = await post(
      jsonRequest(
        '/api/system-parameters',
        {
          key: `max-retries-${stamp}`,
          category,
          valueType: 'number',
          value: 1,
        },
        cookie,
      ),
      route(['system-parameters']),
    )
    expect(duplicate.status).toBe(400)
    expect(JSON.stringify(await duplicate.json()).toLowerCase()).toContain('unique')
  })

  it('masks sensitive values on read, list, export, and audit, and still serves getParameter', async () => {
    const cookie = await superAdminCookie()
    const secret = `internal-allowlist-${stamp}`
    const key = `billing-allowlist-${stamp}`
    const req = {} as PayloadRequest
    const created = await payload.create({
      collection: SYSTEM_PARAMETERS_SLUG,
      data: {
        key,
        category: 'billing',
        valueType: 'string',
        value: secret,
        sensitive: true,
      },
      overrideAccess: true,
      req,
    })
    createdParameterIds.push(created.id)
    expect(created.value).toBeNull()
    expect(JSON.stringify(created)).not.toContain(secret)

    const audit = readSystemParameterAudit(req.context, created.id)
    expect(audit?.next?.value).toEqual(REDACTED_PARAMETER_VALUE)
    expect(JSON.stringify(audit)).not.toContain(secret)
    expect(await getParameter(payload, key)).toBe(secret)

    const listed = await get(
      jsonRequest(
        `/api/system-parameters?where[key][equals]=${key}`,
        undefined,
        cookie,
        ORIGIN,
        'GET',
      ),
      route(['system-parameters']),
    )
    expect(listed.status).toBe(200)
    const listedBody = JSON.stringify(await listed.json())
    expect(listedBody).not.toContain(secret)
    expect(listedBody).toContain('"sensitive":true')

    const queried = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `query Read($key: String!) {
          SystemParameters(where: { key: { equals: $key } }, limit: 1) {
            docs { value sensitive }
          }
        }`,
          variables: { key },
        },
        cookie,
      ),
    )
    const queriedBody = JSON.stringify(await queried.json())
    expect(queriedBody).not.toContain(secret)
    expect(queriedBody).toContain('"sensitive":true')

    const exported = await get(
      jsonRequest('/api/system-parameters/export', undefined, cookie, ORIGIN, 'GET'),
      route(['system-parameters', 'export']),
    )
    expect(exported.status).toBe(200)
    expect(await exported.text()).not.toContain(secret)

    const byId = await get(
      jsonRequest(`/api/system-parameters/${created.id}`, undefined, cookie, ORIGIN, 'GET'),
      route(['system-parameters', String(created.id)]),
    )
    expect(byId.status).toBe(200)
    const byIdBody = JSON.stringify(await byId.json())
    expect(byIdBody).not.toContain(secret)
    expect(byIdBody).toContain('"value":null')

    const mutated = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `mutation Update($id: Int!, $label: String) {
          updateSystemParameter(id: $id, data: { label: $label }) { value sensitive }
        }`,
          variables: { id: Number(created.id), label: 'Allow list' },
        },
        cookie,
      ),
    )
    const mutatedBody = JSON.stringify(await mutated.json())
    expect(mutatedBody).not.toContain(secret)
    expect(mutatedBody).toContain('"value":null')
    expect(mutatedBody).toContain('"sensitive":true')

    const rotated = await patch(
      jsonRequest(
        `/api/system-parameters/${created.id}`,
        { value: null, label: 'Allow list' },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['system-parameters', String(created.id)]),
    )
    expect(rotated.status).toBeLessThan(300)
    expect(JSON.stringify(await rotated.json())).not.toContain(secret)
    expect(await getParameter(payload, key)).toBe(secret)
  })

  it('gates edits on collection permissions', async () => {
    const readerRole = await createRole(`param-reader-${stamp}`)
    await grant(readerRole.id, 'system-parameters:read')
    await grant(readerRole.id, 'system-parameters:readField:key')
    await grant(readerRole.id, 'system-parameters:readField:value')
    const reader = await createAccount(`param-reader-${stamp}@example.com`, [readerRole.id])
    const readerCookie = await loginCookie(reader.email)

    const editorRole = await createRole(`param-editor-${stamp}`)
    for (const key of await permissionKeys('system-parameters:')) {
      if (key.endsWith(':delete') || key.includes(':delete')) continue
      if (key.includes('delete')) continue
      await grant(editorRole.id, key)
    }
    const editor = await createAccount(`param-editor-${stamp}@example.com`, [editorRole.id])
    const editorCookie = await loginCookie(editor.email)

    const anonymous = await post(
      jsonRequest('/api/system-parameters', {
        key: `anon-${stamp}`,
        category: 'operations',
        valueType: 'string',
        value: 'nope',
      }),
      route(['system-parameters']),
    )
    expect(anonymous.status).toBe(403)

    const created = await createOverRest(editorCookie, {
      key: `editor-threshold-${stamp}`,
      category: 'operations',
      valueType: 'number',
      value: 5,
    })
    const denied = await patch(
      jsonRequest(
        `/api/system-parameters/${created.id}`,
        { value: 9 },
        readerCookie,
        ORIGIN,
        'PATCH',
      ),
      route(['system-parameters', String(created.id)]),
    )
    expect(denied.status).toBe(403)
    expect(await getParameter(payload, `editor-threshold-${stamp}`)).toBe(5)

    const allowed = await patch(
      jsonRequest(
        `/api/system-parameters/${created.id}`,
        { value: 9 },
        editorCookie,
        ORIGIN,
        'PATCH',
      ),
      route(['system-parameters', String(created.id)]),
    )
    expect(allowed.status).toBeLessThan(300)
    expect(await getParameter(payload, `editor-threshold-${stamp}`)).toBe(9)

    const graphqlDenied = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `mutation Update($id: Int!, $value: JSON) {
          updateSystemParameter(id: $id, data: { value: $value }) { id }
        }`,
          variables: { id: Number(created.id), value: 3 },
        },
        readerCookie,
      ),
    )
    expect(JSON.stringify(await graphqlDenied.json()).toLowerCase()).toMatch(
      /not allowed|forbidden|unauthorized/,
    )
    expect(await getParameter(payload, `editor-threshold-${stamp}`)).toBe(9)
  })

  it('invalidates the writing isolate immediately and other isolates after the version check', async () => {
    const key = `cache-mode-${stamp}`
    const cookie = await superAdminCookie()
    const created = await createOverRest(cookie, {
      key,
      category: 'operations',
      valueType: 'string',
      value: 'one',
    })
    expect(await getParameter(payload, key, { default: 'missing' })).toBe('one')

    const clock = { now: 8_000_000 }
    const otherIsolate = new ParameterReadCache({
      memory: createIsolateMemory(),
      versions: createPayloadVersionStore(payload),
      load: (parameterKey) => loadParameter(payload, parameterKey),
      readKv: async () => undefined,
      writeKv: async () => undefined,
      now: () => clock.now,
      verifyTtlMs: PARAMETER_CACHE_VERIFY_TTL_MS,
      maxAgeMs: PARAMETER_CACHE_MAX_AGE_MS,
    })
    expect((await otherIsolate.read(key))?.value).toBe('one')

    const updated = await patch(
      jsonRequest(
        `/api/system-parameters/${created.id}`,
        { value: 'two' },
        cookie,
        ORIGIN,
        'PATCH',
      ),
      route(['system-parameters', String(created.id)]),
    )
    expect(updated.status).toBeLessThan(300)
    expect(await getParameter(payload, key)).toBe('two')

    clock.now += 500
    expect((await otherIsolate.read(key))?.value).toBe('one')
    clock.now += PARAMETER_CACHE_VERIFY_TTL_MS
    expect((await otherIsolate.read(key))?.value).toBe('two')

    const deleted = await remove(
      jsonRequest(`/api/system-parameters/${created.id}`, undefined, cookie, ORIGIN, 'DELETE'),
      route(['system-parameters', String(created.id)]),
    )
    expect(deleted.status).toBeLessThan(300)
    createdParameterIds.splice(createdParameterIds.indexOf(created.id), 1)
    expect(await getParameter(payload, key, { default: 'gone' })).toBe('gone')
    clock.now += 500
    expect((await otherIsolate.read(key))?.value).toBe('two')
    clock.now += PARAMETER_CACHE_VERIFY_TTL_MS
    expect(await otherIsolate.read(key)).toBeNull()
    await expect(getParameter(payload, key, { default: 1 })).resolves.toBe(1)
    await expect(
      getParameter(payload, `max-retries-${stamp}`, { default: 'nope' }),
    ).rejects.toBeInstanceOf(ParameterTypeMismatchError)
  })

  it('requires full access and a new value before sensitive can be turned off', async () => {
    const admin = await superAdminCookie()
    const editor = await editorSession('unmask')
    const secret = `stored-secret-${stamp}`
    const key = `billing-window-${stamp}`
    const created = await createOverRest(admin, {
      key,
      category: 'billing',
      valueType: 'string',
      value: secret,
      sensitive: true,
    })

    await expectRestUnmask(editor, created.id, { sensitive: false }, secret, 403)
    await expectRestUnmask(editor, created.id, { value: null, sensitive: false }, secret, 403)
    await expectGraphqlUnmask(
      editor,
      created.id,
      'sensitive: false',
      secret,
      /not allowed|forbidden/,
    )
    await expectGraphqlUnmask(
      editor,
      created.id,
      'sensitive: false, value: null',
      secret,
      /not allowed|forbidden/,
    )

    await expectRestUnmask(
      admin,
      created.id,
      { sensitive: false },
      secret,
      400,
      PARAMETER_UNMASK_VALUE_ERROR,
    )
    await expectRestUnmask(
      admin,
      created.id,
      { value: null, sensitive: false },
      secret,
      400,
      PARAMETER_UNMASK_VALUE_ERROR,
    )
    await expectGraphqlUnmask(
      admin,
      created.id,
      'sensitive: false',
      secret,
      new RegExp(PARAMETER_UNMASK_VALUE_ERROR),
    )
    await expectGraphqlUnmask(
      admin,
      created.id,
      'sensitive: false, value: null',
      secret,
      new RegExp(PARAMETER_UNMASK_VALUE_ERROR),
    )
    expect(await getParameter(payload, key)).toBe(secret)

    const replacement = `public-window-${stamp}`
    const cleared = await patch(
      jsonRequest(
        `/api/system-parameters/${created.id}`,
        { sensitive: false, value: replacement },
        admin,
        ORIGIN,
        'PATCH',
      ),
      route(['system-parameters', String(created.id)]),
    )
    const clearedBody = JSON.stringify(await cleared.json())
    expect(cleared.status, clearedBody).toBeLessThan(300)
    expect(clearedBody).toContain(replacement)
    expect(clearedBody).not.toContain(secret)
    expect(await getParameter(payload, key)).toBe(replacement)

    const secondSecret = `graphql-secret-${stamp}`
    const second = await createOverRest(admin, {
      key: `billing-graphql-${stamp}`,
      category: 'billing',
      valueType: 'string',
      value: secondSecret,
      sensitive: true,
    })
    const graphqlCleared = await graphql(
      jsonRequest(
        '/api/graphql',
        {
          query: `mutation Clear($id: Int!, $value: JSON!) {
          updateSystemParameter(id: $id, data: { sensitive: false, value: $value }) { value sensitive }
        }`,
          variables: { id: Number(second.id), value: 'graphql-public' },
        },
        admin,
      ),
    )
    const graphqlBody = JSON.stringify(await graphqlCleared.json())
    expect(graphqlBody).toContain('graphql-public')
    expect(graphqlBody).not.toContain(secondSecret)
    expect(graphqlBody).toContain('"sensitive":false')
    expect(await getParameter(payload, `billing-graphql-${stamp}`)).toBe('graphql-public')
  })

  it('refuses value filters and sorts for users without full access', async () => {
    const admin = await superAdminCookie()
    const editor = await editorSession('query')
    const secret = `guess-me-${stamp}`
    const key = `guess-${stamp}`
    await createOverRest(admin, {
      key,
      category: 'operations',
      valueType: 'string',
      value: secret,
      sensitive: true,
    })

    const filtered = await get(
      jsonRequest(
        `/api/system-parameters?where[value][like]=${encodeURIComponent('guess%')}`,
        undefined,
        editor,
        ORIGIN,
        'GET',
      ),
      route(['system-parameters']),
    )
    const filteredBody = JSON.stringify(await filtered.json())
    expect(filtered.status).toBe(400)
    expect(filteredBody).toContain(PARAMETER_VALUE_QUERY_ERROR)
    expect(filteredBody).not.toContain(secret)

    const nested = await get(
      jsonRequest(
        '/api/system-parameters?where[and][0][value][equals]=guess-me',
        undefined,
        editor,
        ORIGIN,
        'GET',
      ),
      route(['system-parameters']),
    )
    expect(nested.status).toBe(400)
    expect(JSON.stringify(await nested.json())).toContain(PARAMETER_VALUE_QUERY_ERROR)

    const sorted = await get(
      jsonRequest('/api/system-parameters?sort=value', undefined, editor, ORIGIN, 'GET'),
      route(['system-parameters']),
    )
    expect(sorted.status).toBe(400)
    expect(JSON.stringify(await sorted.json())).toContain(PARAMETER_VALUE_QUERY_ERROR)

    for (const path of [
      `/api/system-parameters?where[AND][0][value][like]=${encodeURIComponent('a%')}`,
      '/api/system-parameters?where[Or][0][value][equals]=x',
      `/api/system-parameters?where[value__flag][like]=${encodeURIComponent('a%')}`,
      '/api/system-parameters?sort=-value__flag',
      `/api/system-parameters/count?where[AND][0][value][like]=${encodeURIComponent('a%')}`,
      '/api/system-parameters/count?where[Or][0][value__flag][exists]=true',
      `/api/system-parameters/export?where[AND][0][value][like]=${encodeURIComponent('a%')}`,
      '/api/system-parameters/export?where[Or][0][value__flag][like]=a',
      '/api/system-parameters/export?sort=value__flag',
    ]) {
      const response = await get(
        jsonRequest(path, undefined, editor, ORIGIN, 'GET'),
        apiRoute(path),
      )
      const body = await response.text()
      expect(response.status, `${path} ${body}`).toBe(400)
      expect(body, path).toContain(PARAMETER_VALUE_QUERY_ERROR)
      expect(body, path).not.toContain(secret)
    }

    for (const query of [
      `query { SystemParameters(where: { AND: [{ value: { like: "a%" } }] }, limit: 1) { totalDocs } }`,
      `query { SystemParameters(where: { OR: [{ value: { equals: "x" } }] }, limit: 1) { totalDocs } }`,
      `query { SystemParameters(sort: "value", limit: 1) { totalDocs } }`,
      `query { SystemParameters(sort: "-value__flag", limit: 1) { totalDocs } }`,
      `query { countSystemParameters(where: { value: { like: "a%" } }) { totalDocs } }`,
    ]) {
      const response = await graphql(jsonRequest('/api/graphql', { query }, editor))
      const body = JSON.stringify(await response.json())
      expect(body, query).toContain(PARAMETER_VALUE_QUERY_ERROR)
      expect(body, query).not.toContain(secret)
    }

    const allowed = await get(
      jsonRequest(
        `/api/system-parameters?where[key][equals]=${key}`,
        undefined,
        editor,
        ORIGIN,
        'GET',
      ),
      route(['system-parameters']),
    )
    const allowedBody = JSON.stringify(await allowed.json())
    expect(allowed.status).toBe(200)
    expect(allowedBody).not.toContain(secret)
    expect(await getParameter(payload, key)).toBe(secret)
  })

  it('masks every row in a bulk update', async () => {
    const admin = await superAdminCookie()
    const firstSecret = `bulk-secret-a-${stamp}`
    const secondSecret = `bulk-secret-b-${stamp}`
    const first = await createOverRest(admin, {
      key: `bulk-a-${stamp}`,
      category: 'operations',
      valueType: 'string',
      value: firstSecret,
      sensitive: true,
    })
    const second = await createOverRest(admin, {
      key: `bulk-b-${stamp}`,
      category: 'operations',
      valueType: 'string',
      value: secondSecret,
      sensitive: true,
    })
    const response = await patch(
      jsonRequest(
        `/api/system-parameters?where[id][in][0]=${first.id}&where[id][in][1]=${second.id}`,
        { label: 'batched' },
        admin,
        ORIGIN,
        'PATCH',
      ),
      route(['system-parameters']),
    )
    const body = JSON.stringify(await response.json())
    expect(response.status, body).toBe(200)
    expect(body).not.toContain(firstSecret)
    expect(body).not.toContain(secondSecret)
    expect(body).toContain('"value":null')
    expect(await getParameter(payload, `bulk-a-${stamp}`)).toBe(firstSecret)
    expect(await getParameter(payload, `bulk-b-${stamp}`)).toBe(secondSecret)
  })

  it('rejects a number to string change that keeps the stored value', async () => {
    const admin = await superAdminCookie()
    const key = `threshold-${stamp}`
    const created = await createOverRest(admin, {
      key,
      category: 'operations',
      valueType: 'number',
      value: 42,
    })
    const response = await patch(
      jsonRequest(
        `/api/system-parameters/${created.id}`,
        { valueType: 'string' },
        admin,
        ORIGIN,
        'PATCH',
      ),
      route(['system-parameters', String(created.id)]),
    )
    const body = JSON.stringify(await response.json())
    expect(response.status).toBe(400)
    expect(body).toContain(PARAMETER_STRING_VALUE_ERROR)
    expect(await getParameter(payload, key)).toBe(42)
  })
})

async function expectRestUnmask(
  cookie: string,
  id: number,
  data: { sensitive: boolean; value?: unknown },
  secret: string,
  status: number,
  message?: string,
): Promise<void> {
  const response = await patch(
    jsonRequest(`/api/system-parameters/${id}`, data, cookie, ORIGIN, 'PATCH'),
    route(['system-parameters', String(id)]),
  )
  const body = JSON.stringify(await response.json())
  expect(response.status, body).toBe(status)
  if (message) {
    expect(body).toContain(message)
  }
  expect(body).not.toContain(secret)
  const masked = await get(
    jsonRequest(`/api/system-parameters/${id}`, undefined, cookie, ORIGIN, 'GET'),
    route(['system-parameters', String(id)]),
  )
  const maskedBody = JSON.stringify(await masked.json())
  expect(maskedBody).not.toContain(secret)
  expect(maskedBody).toContain('"sensitive":true')
}

async function expectGraphqlUnmask(
  cookie: string,
  id: number,
  dataFields: string,
  secret: string,
  message: RegExp,
): Promise<void> {
  const response = await graphql(
    jsonRequest(
      '/api/graphql',
      {
        query: `mutation Unmask($id: Int!) {
          updateSystemParameter(id: $id, data: { ${dataFields} }) { id value sensitive }
        }`,
        variables: { id },
      },
      cookie,
    ),
  )
  const body = JSON.stringify(await response.json())
  expect(body).toMatch(message)
  expect(body).not.toContain(secret)
}

function route(slug: string[]) {
  return { params: Promise.resolve({ slug }) }
}

function apiRoute(path: string) {
  const pathname = path.split('?')[0] ?? path
  return route(
    pathname
      .replace(/^\/api\//, '')
      .split('/')
      .filter(Boolean),
  )
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

async function createOverRest(
  cookie: string,
  data: { key: string; category: string; valueType: string; value: unknown; sensitive?: boolean },
): Promise<{ id: number; value: unknown }> {
  const response = await post(
    jsonRequest('/api/system-parameters', data, cookie),
    route(['system-parameters']),
  )
  const body = (await response.json()) as {
    doc?: { id?: number; value?: unknown }
    errors?: unknown
  }
  expect(response.status, JSON.stringify(body)).toBeLessThan(300)
  const id = Number(body.doc?.id)
  expect(id).toBeGreaterThan(0)
  createdParameterIds.push(id)
  return { id, value: body.doc?.value }
}

async function superAdminCookie(): Promise<string> {
  const role = await findSuperAdminRole()
  const email = `param-admin-${stamp}@example.com`
  const existing = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { email: { equals: email } },
  })
  if (!existing.docs[0]) {
    await createAccount(email, [role.id])
  }
  return loginCookie(email)
}

async function findSuperAdminRole(): Promise<{ id: number }> {
  const result = await payload.find({
    collection: 'roles' as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { slug: { equals: 'super-admin' } },
  })
  if (!result.docs[0]) {
    throw new Error('super-admin role was not seeded')
  }
  return { id: Number(result.docs[0].id) }
}

async function editorSession(label: string): Promise<string> {
  const role = await createRole(`param-editor-${label}-${stamp}`)
  for (const key of await permissionKeys('system-parameters:')) {
    if (key.includes('delete')) continue
    await grant(role.id, key)
  }
  const editor = await createAccount(`param-editor-${label}-${stamp}@example.com`, [role.id])
  return loginCookie(editor.email)
}

async function createRole(slug: string): Promise<{ id: number }> {
  const role = await payload.create({
    collection: 'roles' as CollectionSlug,
    data: { name: slug, slug, grantsFullAccess: false },
    overrideAccess: true,
  })
  createdRoleIds.push(role.id)
  return { id: Number(role.id) }
}

async function grant(roleId: number, key: string): Promise<void> {
  await setRoleGrant(payload, {
    roleId,
    permissionId: await permissionIdFor(key),
    granted: true,
  })
}

async function permissionKeys(prefix: string): Promise<string[]> {
  const result = await payload.find({
    collection: 'permissions' as CollectionSlug,
    depth: 0,
    limit: 200,
    overrideAccess: true,
    pagination: false,
    where: { key: { contains: prefix } },
  })
  return result.docs
    .map((doc) => (doc as { key?: string }).key)
    .filter((key): key is string => typeof key === 'string' && key.startsWith(prefix))
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

async function createAccount(
  email: string,
  roles: number[],
): Promise<{ id: number; email: string }> {
  const user = await payload.create({
    collection: 'users',
    data: { email, password: 'test-password-123', roles },
    overrideAccess: true,
    context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
  })
  createdUserIds.push(user.id)
  return { id: Number(user.id), email: user.email }
}

async function loginCookie(email: string): Promise<string> {
  const response = await post(
    jsonRequest('/api/users/login', { email, password: 'test-password-123' }),
    route(['users', 'login']),
  )
  expect(response.status).toBe(200)
  const cookie = cookieHeader(response)
  expect(cookie).toContain('payload-token=')
  return cookie
}
