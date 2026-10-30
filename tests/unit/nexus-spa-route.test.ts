import assert from 'node:assert/strict'
import test from 'node:test'

import { createNexusAppRoute, fetchNexusAsset, resolveNexusSpaUpstreamPath } from '../../src/nexus/nexus-route'

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
    ['/nexus/assets/logo.svg', '/assets/logo.svg'],
    ['/nexus/assets/photo.jpeg', '/assets/photo.jpeg'],
    ['/nexus/assets/font.woff2', '/assets/font.woff2'],
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
    '/nexus/%61pi/v1/records/x.js',
    '/nexus//api/health.js',
    '/nexus/API/health.js',
    '/nexus/%2e%2e/api',
    '/nexus/assets/%2e%2e/api/health.js',
    '/nexus/assets/../api/health.js',
    '/nexus/./api',
    '/nexus/assets\\..\\api',
    '/nexus/Mcp',
    '/nexus/logo.svg',
    '/nexus/favicon.png',
    '/nexus/assets/favicon.ico/x',
    '/nexus/%66avicon.ico',
    '/nexus//favicon.ico',
    '/nexus/./favicon.ico',
    '/nexus/../favicon.ico',
    '/nexus\\favicon.ico',
    '/nexus/api/favicon.ico',
    '/nexus/MCP/robots.txt',
    '/nexus/Assets/../favicon.ico',
    '/nexus/aPi',
    '/nexus/assets/',
    '/nexusapi/health',
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

test('resolveNexusSpaUpstreamPath allows the explicit root files', () => {
  for (const file of ['favicon.ico', 'favicon.svg', 'robots.txt', 'manifest.webmanifest', 'apple-touch-icon.png']) {
    assert.equal(resolveNexusSpaUpstreamPath(`/nexus/${file}`), `/${file}`, file)
  }
  assert.equal(resolveNexusSpaUpstreamPath('/nexus/FAVICON.ICO'), '/favicon.ico')
})

function fakeNexus(answer: (url: string) => Response) {
  const fetches: string[] = []
  const nexus = {
    fetch: async (input: RequestInfo | URL) => {
      fetches.push(String(input))
      return answer(String(input))
    },
  }
  return { nexus: nexus as unknown as Fetcher, fetches }
}

test('fetchNexusAsset does not forward the query string', async () => {
  const { nexus, fetches } = fakeNexus(() => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }))
  const request = new Request('https://template.example/nexus/contacts?token=abc&x=1')
  const path = resolveNexusSpaUpstreamPath(new URL(request.url).pathname)!
  const response = await fetchNexusAsset(nexus, path, request)
  assert.equal(response.status, 200)
  assert.deepEqual(fetches, ['https://nexus.internal/'])
  const { nexus: n2, fetches: f2 } = fakeNexus(() => new Response('x', { headers: { 'content-type': 'text/javascript' } }))
  await fetchNexusAsset(n2, '/assets/index-abc.js', new Request('https://template.example/nexus/assets/index-abc.js?v=2'))
  assert.deepEqual(f2, ['https://nexus.internal/assets/index-abc.js'])
})

test('fetchNexusAsset serves a root file that exists in the build', async () => {
  const { nexus, fetches } = fakeNexus(() => new Response('icon', { headers: { 'content-type': 'image/x-icon' } }))
  const response = await fetchNexusAsset(nexus, '/favicon.ico', new Request('https://template.example/nexus/favicon.ico?v=1'))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'icon')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(fetches, ['https://nexus.internal/favicon.ico'])
})

test('fetchNexusAsset returns 404 for a root file missing from the build', async () => {
  // The asset store answers a missing file with the SPA index.
  const spa = fakeNexus(() => new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }))
  const fallback = await fetchNexusAsset(spa.nexus, '/robots.txt', new Request('https://template.example/nexus/robots.txt'))
  assert.equal(fallback.status, 404)
  assert.equal(await fallback.text(), 'Not Found')
  const missing = fakeNexus(() => new Response('nope', { status: 404 }))
  const gone = await fetchNexusAsset(missing.nexus, '/favicon.svg', new Request('https://template.example/nexus/favicon.svg'))
  assert.equal(gone.status, 404)
})
