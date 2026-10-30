import assert from 'node:assert/strict'
import test from 'node:test'

import { createNexusAppRoute, resolveNexusSpaUpstreamPath } from '../../src/nexus/nexus-route'

test('resolveNexusSpaUpstreamPath allows the index and SPA deep links', () => {
  assert.equal(resolveNexusSpaUpstreamPath('/nexus'), '/')
  assert.equal(resolveNexusSpaUpstreamPath('/nexus/'), '/')
  assert.equal(resolveNexusSpaUpstreamPath('/nexus/index.html'), '/index.html')
  assert.equal(resolveNexusSpaUpstreamPath('/nexus/contacts'), '/')
  assert.equal(resolveNexusSpaUpstreamPath('/nexus/contacts/abc-123'), '/')
  assert.equal(resolveNexusSpaUpstreamPath('/nexus/settings/tokens'), '/')
})

test('resolveNexusSpaUpstreamPath allows static asset extensions', () => {
  const cases: Array<[string, string]> = [
    ['/nexus/assets/index-abc123.js', '/assets/index-abc123.js'],
    ['/nexus/assets/index-abc123.css', '/assets/index-abc123.css'],
    ['/nexus/favicon.ico', '/favicon.ico'],
    ['/nexus/logo.svg', '/logo.svg'],
    ['/nexus/hero.png', '/hero.png'],
    ['/nexus/photo.jpg', '/photo.jpg'],
    ['/nexus/photo.jpeg', '/photo.jpeg'],
    ['/nexus/font.woff', '/font.woff'],
    ['/nexus/font.woff2', '/font.woff2'],
    ['/nexus/assets/index-abc123.js.map', '/assets/index-abc123.js.map'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(resolveNexusSpaUpstreamPath(input), expected, input)
  }
})

test('resolveNexusSpaUpstreamPath refuses non-asset paths that would reach Nexus Worker routes', () => {
  for (const path of [
    '/nexus/api',
    '/nexus/api/health',
    '/nexus/api/v1/records',
    '/nexus/api/auth/login',
    '/nexus/api/bridge/mcp-token',
    '/nexus/mcp',
    '/nexus/mcp/tools',
    '/nexus/secret.env',
    '/nexus/assets/index.exe',
    '/nexus/config.json',
    '/nexus/api/health.js',
    '/nexus/mcp.js',
    '/nexus/api/bridge/mcp-token.map',
  ]) {
    assert.equal(resolveNexusSpaUpstreamPath(path), null, path)
  }
})

test('createNexusAppRoute returns 404 for a non-asset /nexus/ path without fetching Nexus', async () => {
  const fetches: string[] = []
  const nexus = {
    fetch: async (input: RequestInfo | URL) => {
      fetches.push(String(input))
      return new Response('should-not-run', { status: 200 })
    },
  }
  const handle = createNexusAppRoute({
    getServices: async () =>
      ({
        payload: {
          auth: async () => {
            throw new Error('authorize must not run for refused paths')
          },
        },
        nexus,
        secret: 'x'.repeat(32),
      }) as never,
  })
  const response = await handle(new Request('https://template.example/nexus/api/health'))
  assert.equal(response.status, 404)
  assert.equal(await response.text(), 'Not Found')
  assert.deepEqual(fetches, [])
})
