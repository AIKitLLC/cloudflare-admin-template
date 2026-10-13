import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

// All signing material and Firebase identifiers below are local synthetic fixtures.
// Every Worker outbound request is intercepted; this script never contacts Firebase.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const sourcePath = resolve(root, 'src/auth/firebase-client.ts')
const source = await readFile(sourcePath, 'utf8')
const adapterPath = resolve(root, 'src/auth/firebase-client-route.ts')
const adapterSource = await readFile(adapterPath, 'utf8')
const routePath = resolve(root, 'src/app/api/client/v1/me/route.ts')
const routeSource = await readFile(routePath, 'utf8')
const cloudflareContextPath = require.resolve('@opennextjs/cloudflare/cloudflare-context')
const cloudflareContextSource = await readFile(cloudflareContextPath, 'utf8')
const lockPath = resolve(root, 'pnpm-lock.yaml')
const lock = await readFile(lockPath, 'utf8')
const configPath = resolve(root, 'wrangler.jsonc')
const config = await readFile(configPath, 'utf8')
// The template uses JSONC comments and trailing commas, so JSON.parse is unsuitable.
const compatibilityDate = /^\s*"compatibility_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/m.exec(config)?.[1]
assert.ok(compatibilityDate, 'wrangler.jsonc must specify a compatibility_date')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const nowMs = Date.parse('2026-10-13T16:00:00.000Z')
const projectId = 'template-fixture'
const projectNumber = '123456789'
const uid = 'synthetic-anonymous-uid'
const appId = `1:${projectNumber}:android:0123456789abcdef`
const appEndpoint = 'https://firebaseappcheck.googleapis.com/v1/jwks'
const idEndpoint =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
const environment = {
  FIREBASE_CLIENT_ENABLED: 'true',
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_PROJECT_NUMBER: projectNumber,
  FIREBASE_APP_IDS: appId,
}
const makePair = () => generateKeyPairSync('rsa', { modulusLength: 2048 })
const appPair = makePair(),
  idPair = makePair(),
  rotatedAppPair = makePair(),
  rotatedIdPair = makePair()
const appKid = 'synthetic-app-key',
  idKid = 'synthetic-id-key'
const rotatedAppKid = 'synthetic-app-key-2',
  rotatedIdKid = 'synthetic-id-key-2'
const jwk = (pair, kid) => ({
  ...pair.publicKey.export({ format: 'jwk' }),
  kid,
  alg: 'RS256',
  use: 'sig',
})
const appJwk = jwk(appPair, appKid),
  rotatedAppJwk = jwk(rotatedAppPair, rotatedAppKid)
const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

function der(tag, ...parts) {
  const body = Buffer.concat(parts),
    size = body.length
  const length = size < 128 ? [size] : size < 256 ? [0x81, size] : [0x82, size >> 8, size & 255]
  return Buffer.concat([Buffer.from([tag, ...length]), body])
}

// A tiny self-signed X.509 fixture exercises jose.importX509 and workerd Web Crypto.
function certificate(pair) {
  const algorithm = der(
    0x30,
    der(6, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 0x0b])),
    der(5),
  )
  const name = der(
    0x30,
    der(
      0x31,
      der(
        0x30,
        der(6, Buffer.from([0x55, 4, 3])),
        der(0x0c, Buffer.from('Synthetic Firebase Test')),
      ),
    ),
  )
  const validity = der(
    0x30,
    der(0x17, Buffer.from('260101000000Z')),
    der(0x17, Buffer.from('270101000000Z')),
  )
  const tbs = der(
    0x30,
    der(0xa0, der(2, Buffer.from([2]))),
    der(2, Buffer.from([1])),
    algorithm,
    name,
    validity,
    name,
    pair.publicKey.export({ format: 'der', type: 'spki' }),
  )
  const signature = sign('RSA-SHA256', tbs, pair.privateKey)
  const value = der(0x30, tbs, algorithm, der(3, Buffer.from([0]), signature)).toString('base64')
  return `-----BEGIN CERTIFICATE-----\n${value.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`
}
const idCertificate = certificate(idPair),
  rotatedIdCertificate = certificate(rotatedIdPair)

function jwt(payload, pair, kid, header = {}) {
  const input = `${encoded({ alg: 'RS256', kid, typ: 'JWT', ...header })}.${encoded(payload)}`
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), pair.privateKey).toString('base64url')}`
}

function tokens(appClaims = {}, idClaims = {}, appHeader = {}, idHeader = {}, rotated = false) {
  return {
    app: jwt(
      {
        iss: `https://firebaseappcheck.googleapis.com/${projectNumber}`,
        aud: [`projects/${projectNumber}`],
        sub: appId,
        iat: nowMs / 1000 - 10,
        exp: nowMs / 1000 + 3600,
        ...appClaims,
      },
      rotated ? rotatedAppPair : appPair,
      rotated ? rotatedAppKid : appKid,
      appHeader,
    ),
    id: jwt(
      {
        iss: `https://securetoken.google.com/${projectId}`,
        aud: projectId,
        sub: uid,
        iat: nowMs / 1000 - 10,
        exp: nowMs / 1000 + 3600,
        auth_time: nowMs / 1000 - 30,
        firebase: { sign_in_provider: 'anonymous' },
        ...idClaims,
      },
      rotated ? rotatedIdPair : idPair,
      rotated ? rotatedIdKid : idKid,
      idHeader,
    ),
  }
}
const valid = tokens()
const rotated = tokens({}, {}, {}, {}, true)
const wrongSignature = tokens()
wrongSignature.app = jwt(
  {
    iss: `https://firebaseappcheck.googleapis.com/${projectNumber}`,
    aud: [`projects/${projectNumber}`],
    sub: appId,
    iat: nowMs / 1000 - 10,
    exp: nowMs / 1000 + 3600,
  },
  rotatedAppPair,
  appKid,
)
const wrongIdSignature = tokens()
wrongIdSignature.id = jwt(
  {
    iss: `https://securetoken.google.com/${projectId}`,
    aud: projectId,
    sub: uid,
    iat: nowMs / 1000 - 10,
    exp: nowMs / 1000 + 3600,
    auth_time: nowMs / 1000 - 30,
    firebase: { sign_in_provider: 'anonymous' },
  },
  rotatedIdPair,
  idKid,
)

// Controls affect only this synthetic wrapper, never the application verifier.
const workerEntry = `import {createFirebaseClientAuthenticator,FirebaseAuthError} from './src/auth/firebase-client.ts';
let now=${nowMs};
const authenticate=createFirebaseClientAuthenticator({nowMs:()=>now});
export default {async fetch(request) {
 now=${nowMs}+Number(request.headers.get('X-Test-Clock-Offset')??0);
 const environment=${JSON.stringify(environment)};
 if(request.headers.get('X-Test-Config')==='disabled')environment.FIREBASE_CLIENT_ENABLED='false';
 if(request.headers.get('X-Test-Config')==='incomplete')delete environment.FIREBASE_APP_IDS;
 try {
  const principal=await authenticate(request,environment);
  return Response.json({ok:true,principalMatches:principal.uid===${JSON.stringify(uid)}&&principal.appId===${JSON.stringify(appId)}&&principal.projectId===${JSON.stringify(projectId)}});
 }catch(error){return Response.json({ok:false,reason:error instanceof FirebaseAuthError?error.reason:'unexpected_error'},
  {status:error instanceof FirebaseAuthError?error.status:503});}
}}`
const bundle = await build({
  stdin: {
    contents: workerEntry,
    resolveDir: root,
    sourcefile: 'synthetic-firebase-runtime.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  plugins: [
    {
      name: 'freeze-firebase-source',
      setup(builder) {
        builder.onLoad({ filter: /[\\/]firebase-client\.ts$/ }, () => ({
          contents: source,
          loader: 'ts',
          resolveDir: dirname(sourcePath),
        }))
      },
    },
  ],
})
const script = bundle.outputFiles[0].text

// Import the real GET only after the synthetic clock is installed: the application
// authenticator captures Date.now when its module's singleton is initialized.
// OpenNext's installed getCloudflareContext reads its real production context symbol.
const routeWorkerEntry = `let now=${nowMs};
Date.now=()=>now;
let route;
export default {async fetch(request) {
 now=${nowMs}+Number(request.headers.get('X-Test-Clock-Offset')??0);
 const environment=${JSON.stringify(environment)};
 if(request.headers.get('X-Test-Config')==='disabled')environment.FIREBASE_CLIENT_ENABLED='false';
 if(request.headers.get('X-Test-Config')==='incomplete')delete environment.FIREBASE_APP_IDS;
 globalThis[Symbol.for('__cloudflare-context__')]={env:environment};
 const {GET}=await(route??=import('./src/app/api/client/v1/me/route.ts'));
 return GET(request);
}}`
const frozenRouteSources = new Map(
  await Promise.all(
    [
      [sourcePath, source],
      [adapterPath, adapterSource],
      [routePath, routeSource],
      [cloudflareContextPath, cloudflareContextSource],
    ].map(async ([path, contents]) => [await realpath(path), contents]),
  ),
)
const routeBundle = await build({
  stdin: {
    contents: routeWorkerEntry,
    resolveDir: root,
    sourcefile: 'synthetic-firebase-protected-route-runtime.ts',
    loader: 'ts',
  },
  alias: { '@': resolve(root, 'src') },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  plugins: [
    {
      name: 'freeze-firebase-route-sources',
      setup(builder) {
        builder.onLoad({ filter: /\.[jt]s$/ }, ({ path }) => {
          const contents = frozenRouteSources.get(path)
          if (contents !== undefined)
            return {
              contents,
              loader: path.endsWith('.ts') ? 'ts' : 'js',
              resolveDir: dirname(path),
            }
        })
      },
    },
  ],
})
const routeScript = routeBundle.outputFiles[0].text
const verifierCases = [
  {
    name: 'signed-anonymous-principal-and-cache',
    tokens: valid,
    repeat: 2,
    status: 200,
    requests: ['app', 'id'],
  },
  {
    name: 'missing-credentials',
    missing: 'both',
    status: 401,
    reason: 'firebase_credentials_missing',
    requests: [],
  },
  {
    name: 'missing-app-check',
    missing: 'app',
    status: 401,
    reason: 'firebase_credentials_missing',
    requests: [],
  },
  {
    name: 'missing-id-token',
    missing: 'id',
    status: 401,
    reason: 'firebase_credentials_missing',
    requests: [],
  },
  {
    name: 'disabled-config',
    config: 'disabled',
    status: 503,
    reason: 'firebase_client_disabled',
    requests: [],
  },
  {
    name: 'incomplete-config',
    config: 'incomplete',
    status: 503,
    reason: 'firebase_client_misconfigured',
    requests: [],
  },
  {
    name: 'wrong-app-project',
    tokens: tokens({ iss: 'https://firebaseappcheck.googleapis.com/987654321' }),
    status: 401,
    requests: ['app'],
  },
  {
    name: 'wrong-app-audience',
    tokens: tokens({ aud: ['projects/987654321'] }),
    status: 401,
    requests: ['app'],
  },
  {
    name: 'wrong-id-issuer',
    tokens: tokens({}, { iss: 'https://securetoken.google.com/another-project' }),
    status: 401,
    requests: ['app', 'id'],
  },
  {
    name: 'wrong-id-project',
    tokens: tokens({}, { aud: 'another-project' }),
    status: 401,
    requests: ['app', 'id'],
  },
  {
    name: 'array-id-audience',
    tokens: tokens({}, { aud: [projectId] }),
    status: 401,
    requests: ['app', 'id'],
  },
  {
    name: 'unlisted-app',
    tokens: tokens({ sub: `1:${projectNumber}:android:unlisted` }),
    status: 401,
    requests: ['app'],
  },
  {
    name: 'non-anonymous-provider',
    tokens: tokens({}, { firebase: { sign_in_provider: 'password' } }),
    status: 401,
    requests: ['app', 'id'],
  },
  {
    name: 'swapped-token-types',
    tokens: { app: valid.id, id: valid.app },
    status: 401,
    requests: ['app'],
  },
  { name: 'invalid-app-signature', tokens: wrongSignature, status: 401, requests: ['app'] },
  { name: 'invalid-id-signature', tokens: wrongIdSignature, status: 401, requests: ['app', 'id'] },
  {
    name: 'expired-app-check',
    tokens: tokens({ exp: nowMs / 1000 }),
    status: 401,
    requests: ['app'],
  },
  {
    name: 'expired-id-token',
    tokens: tokens({}, { exp: nowMs / 1000 }),
    status: 401,
    requests: ['app', 'id'],
  },
  {
    name: 'future-issued-app-check',
    tokens: tokens({ iat: nowMs / 1000 + 1 }),
    status: 401,
    requests: ['app'],
  },
  {
    name: 'future-issued-id-token',
    tokens: tokens({}, { iat: nowMs / 1000 + 1 }),
    status: 401,
    requests: ['app', 'id'],
  },
  {
    name: 'future-auth-time',
    tokens: tokens({}, { auth_time: nowMs / 1000 + 1 }),
    status: 401,
    requests: ['app', 'id'],
  },
  {
    name: 'missing-auth-time',
    tokens: tokens({}, { auth_time: undefined }),
    status: 401,
    requests: ['app', 'id'],
  },
  {
    name: 'nonnumeric-id-iat',
    tokens: tokens({}, { iat: String(nowMs / 1000 - 10) }),
    status: 401,
    requests: ['app', 'id'],
  },
  {
    name: 'empty-id-subject',
    tokens: tokens({}, { sub: '' }),
    status: 401,
    requests: ['app', 'id'],
  },
  {
    name: 'oversized-id-subject',
    tokens: tokens({}, { sub: 'x'.repeat(129) }),
    status: 401,
    requests: ['app', 'id'],
  },
  {
    name: 'unsupported-app-algorithm',
    tokens: tokens({}, {}, { alg: 'HS256' }),
    status: 401,
    requests: [],
  },
  {
    name: 'unsupported-id-algorithm',
    tokens: tokens({}, {}, {}, { alg: 'HS256' }),
    status: 401,
    requests: [],
  },
  {
    name: 'wrong-app-token-type',
    tokens: tokens({}, {}, { typ: 'id-token' }),
    status: 401,
    requests: [],
  },
  {
    name: 'token-key-url-rejected',
    tokens: tokens({}, {}, { jku: 'https://attacker.synthetic.invalid/jwks' }),
    status: 401,
    requests: [],
  },
  {
    name: 'app-keys-outage',
    outage: 'app',
    status: 503,
    reason: 'firebase_keys_unavailable',
    requests: ['app'],
  },
  {
    name: 'id-certificates-outage',
    outage: 'id',
    status: 503,
    reason: 'firebase_keys_unavailable',
    requests: ['app', 'id'],
  },
  {
    name: 'both-provider-key-rotations',
    rotation: true,
    requests: ['app', 'id', 'app', 'id'],
    steps: [
      { tokens: valid, status: 200 },
      { tokens: rotated, offset: 31_000, status: 200 },
    ],
  },
  {
    name: 'unknown-key-cooldown-with-no-store',
    cacheControl: 'no-store',
    requests: ['app', 'id'],
    steps: [
      { tokens: valid, status: 200 },
      { tokens: rotated, offset: 1000, status: 401 },
    ],
  },
  {
    name: 'expired-known-key-outage-fails-closed',
    cacheControl: 'max-age=1',
    outageAt: { app: 2 },
    requests: ['app', 'id', 'app'],
    steps: [
      { tokens: valid, status: 200 },
      { tokens: valid, offset: 2000, status: 503, reason: 'firebase_keys_unavailable' },
    ],
  },
  ...['app', 'id'].flatMap((provider) => {
    const rotatedCredentials =
      provider === 'app' ? { app: rotated.app, id: valid.id } : { app: valid.app, id: rotated.id }
    const outageSteps = [
      { tokens: valid, status: 200 },
      { tokens: valid, offset: 2000, status: 503, reason: 'firebase_keys_unavailable' },
      {
        tokens: rotatedCredentials,
        offset: 3000,
        status: 503,
        reason: 'firebase_keys_unavailable',
      },
    ]
    const shared = {
      cacheControls: { [provider]: 'max-age=1' },
      outageAt: { [provider]: 2 },
      requests: ['app', 'id', provider, provider],
    }
    return [
      {
        name: `${provider}-warm-outage-after-backoff-remains-unavailable`,
        ...shared,
        steps: [
          ...outageSteps,
          {
            tokens: rotatedCredentials,
            offset: 7001,
            status: 503,
            reason: 'firebase_keys_unavailable',
          },
        ],
      },
      {
        name: `${provider}-warm-outage-recovers-after-backoff-with-rotation`,
        ...shared,
        outageThrough: { [provider]: 2 },
        rotationAt: { [provider]: 3 },
        steps: [...outageSteps, { tokens: rotatedCredentials, offset: 7001, status: 200 }],
      },
    ]
  }),
]

const routeCases = [
  {
    name: 'actual-me-route-signed-anonymous-principal-and-cache',
    tokens: valid,
    repeat: 2,
    status: 200,
    requests: ['app', 'id'],
  },
  {
    name: 'actual-me-route-disabled-config',
    config: 'disabled',
    status: 503,
    reason: 'firebase_client_disabled',
    requests: [],
  },
  {
    name: 'actual-me-route-incomplete-config',
    config: 'incomplete',
    status: 503,
    reason: 'firebase_client_misconfigured',
    requests: [],
  },
  {
    name: 'actual-me-route-missing-credentials',
    missing: 'both',
    status: 401,
    reason: 'firebase_credentials_missing',
    requests: [],
  },
  {
    name: 'actual-me-route-missing-app-check',
    missing: 'app',
    status: 401,
    reason: 'firebase_credentials_missing',
    requests: [],
  },
  {
    name: 'actual-me-route-missing-id-token',
    missing: 'id',
    status: 401,
    reason: 'firebase_credentials_missing',
    requests: [],
  },
  {
    name: 'actual-me-route-wrong-app-project',
    tokens: tokens({ iss: 'https://firebaseappcheck.googleapis.com/987654321' }),
    status: 401,
    requests: ['app'],
  },
  {
    name: 'actual-me-route-wrong-id-project',
    tokens: tokens({}, { aud: 'another-project' }),
    status: 401,
    requests: ['app', 'id'],
  },
  {
    name: 'actual-me-route-invalid-app-signature',
    tokens: wrongSignature,
    status: 401,
    requests: ['app'],
  },
  {
    name: 'actual-me-route-invalid-id-signature',
    tokens: wrongIdSignature,
    status: 401,
    requests: ['app', 'id'],
  },
  {
    name: 'actual-me-route-app-provider-outage',
    outage: 'app',
    status: 503,
    reason: 'firebase_keys_unavailable',
    requests: ['app'],
  },
  {
    name: 'actual-me-route-id-provider-outage',
    outage: 'id',
    status: 503,
    reason: 'firebase_keys_unavailable',
    requests: ['app', 'id'],
  },
  {
    name: 'actual-me-route-spoofed-origin-without-credentials',
    missing: 'both',
    origin: 'https://admin.synthetic.invalid',
    status: 401,
    reason: 'firebase_credentials_missing',
    requests: [],
  },
  {
    name: 'actual-me-route-spoofed-origin-with-valid-credentials',
    origin: 'https://admin.synthetic.invalid',
    status: 200,
    requests: ['app', 'id'],
  },
  {
    name: 'actual-me-route-query-uid-and-role-ignored',
    query: '?uid=forged-owner&role=admin',
    status: 200,
    requests: ['app', 'id'],
  },
  {
    // This calls the actual GET export with a body-bearing Request. Next's HTTP
    // method routing is outside this direct-export check and rejects POST itself.
    name: 'actual-me-get-export-body-uid-and-role-ignored',
    method: 'POST',
    body: JSON.stringify({ uid: 'forged-owner', role: 'admin' }),
    status: 200,
    requests: ['app', 'id'],
  },
  {
    name: 'actual-me-get-export-forged-body-cannot-bypass-auth',
    method: 'POST',
    body: JSON.stringify({ uid: 'forged-owner', role: 'admin' }),
    missing: 'both',
    status: 401,
    reason: 'firebase_credentials_missing',
    requests: [],
  },
].map((testCase) => ({ ...testCase, kind: 'route' }))
const cases = [...verifierCases, ...routeCases]

const observations = [],
  start = performance.now()
for (const testCase of cases) {
  const requests = [],
    providerCalls = { app: 0, id: 0 }
  let outboundFailure
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: testCase.kind === 'route' ? routeScript : script,
      compatibilityDate,
      outboundService: async (request) => {
        try {
          const endpoint =
            request.url === appEndpoint ? 'app' : request.url === idEndpoint ? 'id' : 'unexpected'
          requests.push(endpoint)
          assert.notEqual(
            endpoint,
            'unexpected',
            'every outbound request must hit one fixed synthetic provider endpoint',
          )
          assert.equal(request.method, 'GET')
          assert.equal(request.headers.get('Accept'), 'application/json')
          assert.equal(request.headers.get('Authorization'), null)
          assert.equal(request.headers.get('X-Firebase-AppCheck'), null)
          providerCalls[endpoint]++
          if (
            testCase.outage === endpoint ||
            (providerCalls[endpoint] >= (testCase.outageAt?.[endpoint] ?? Infinity) &&
              providerCalls[endpoint] <= (testCase.outageThrough?.[endpoint] ?? Infinity))
          ) {
            return Response.json({ private: 'provider-detail' }, { status: 503 })
          }
          const rotating =
            (testCase.rotation && providerCalls[endpoint] > 1) ||
            providerCalls[endpoint] >= (testCase.rotationAt?.[endpoint] ?? Infinity)
          const keys =
            endpoint === 'app'
              ? { keys: [rotating ? rotatedAppJwk : appJwk] }
              : rotating
                ? { [rotatedIdKid]: rotatedIdCertificate }
                : { [idKid]: idCertificate }
          return Response.json(keys, {
            headers: {
              'Cache-Control':
                testCase.cacheControls?.[endpoint] ?? testCase.cacheControl ?? 'max-age=3600',
            },
          })
        } catch (error) {
          outboundFailure = error
          throw error
        }
      },
    }),
  )
  const results = []
  const steps = testCase.steps ?? Array.from({ length: testCase.repeat ?? 1 }, () => testCase)
  try {
    for (const step of steps) {
      const credentials = step.tokens ?? valid
      const headers = {}
      if (step.missing !== 'both' && step.missing !== 'app')
        headers['X-Firebase-AppCheck'] = credentials.app
      if (step.missing !== 'both' && step.missing !== 'id')
        headers.Authorization = `Bearer ${credentials.id}`
      if (step.config) headers['X-Test-Config'] = step.config
      if (step.offset) headers['X-Test-Clock-Offset'] = String(step.offset)
      if (step.origin) headers.Origin = step.origin
      if (step.body) headers['Content-Type'] = 'application/json'
      const method = step.method ?? (testCase.kind === 'route' ? 'GET' : 'POST')
      const url =
        testCase.kind === 'route'
          ? `https://worker.synthetic.invalid/api/client/v1/me${step.query ?? ''}`
          : 'https://worker.synthetic.invalid/'
      let timeout
      const response = await Promise.race([
        mf.dispatchFetch(url, { method, headers, body: step.body }),
        new Promise((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('local Worker fixture exceeded 10 seconds')),
            10_000,
          )
        }),
      ]).finally(() => clearTimeout(timeout))
      if (outboundFailure) throw outboundFailure
      assert.equal(response.status, step.status, testCase.name)
      const result = await response.json()
      const serialized = JSON.stringify(result)
      const canaries = [credentials.app, credentials.id, 'provider-detail', 'forged-owner']
      if (testCase.kind !== 'route' || step.status !== 200) canaries.push(uid)
      for (const canary of canaries) {
        assert.equal(
          serialized.includes(canary),
          false,
          `${testCase.name}: response must omit credential and provider details`,
        )
      }
      assert.deepEqual(
        result,
        testCase.kind === 'route'
          ? step.status === 200
            ? { principal: { uid, appId, projectId } }
            : { error: step.reason ?? 'firebase_credentials_invalid' }
          : step.status === 200
            ? { ok: true, principalMatches: true }
            : { ok: false, reason: step.reason ?? 'firebase_credentials_invalid' },
        testCase.name,
      )
      let privateHeaders
      if (testCase.kind === 'route') {
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store', testCase.name)
        assert.deepEqual(
          response.headers
            .get('Vary')
            ?.split(',')
            .map((value) => value.trim().toLowerCase())
            .sort(),
          ['authorization', 'x-firebase-appcheck'],
          testCase.name,
        )
        assert.equal(
          response.headers.get('WWW-Authenticate'),
          step.status === 401 ? 'Bearer' : null,
        )
        assert.equal(response.headers.has('Access-Control-Allow-Origin'), false)
        assert.equal(response.headers.has('Set-Cookie'), false)
        privateHeaders = {
          cacheControl: response.headers.get('Cache-Control'),
          vary: response.headers.get('Vary'),
          wwwAuthenticate: response.headers.get('WWW-Authenticate'),
        }
      }
      results.push({ httpStatus: response.status, result, method, privateHeaders })
    }
    assert.deepEqual(
      requests,
      testCase.requests,
      `${testCase.name}: bounded provider calls including cached requests`,
    )
  } finally {
    await mf.dispose()
  }
  observations.push({
    name: testCase.name,
    kind: testCase.kind ?? 'verifier',
    status: 'PASS',
    requests,
    verifiedRequests: steps.length,
    results,
  })
}

assert.equal(
  await readFile(sourcePath, 'utf8'),
  source,
  'runtime-tested Firebase source changed during verification',
)
assert.equal(
  await readFile(lockPath, 'utf8'),
  lock,
  'runtime-tested dependency lock changed during verification',
)
assert.equal(
  await readFile(configPath, 'utf8'),
  config,
  'runtime-tested Worker configuration changed during verification',
)
for (const [path, contents] of [
  [adapterPath, adapterSource],
  [routePath, routeSource],
  [cloudflareContextPath, cloudflareContextSource],
]) {
  assert.equal(await readFile(path, 'utf8'), contents, 'runtime-tested route dependency changed')
}
const packageVersion = async (name, resolver = require) =>
  JSON.parse(await readFile(resolver.resolve(`${name}/package.json`), 'utf8')).version
// pnpm need not hoist Miniflare's workerd dependency into the root node_modules.
const miniflareRequire = createRequire(require.resolve('miniflare'))
const report = {
  status: 'PASS',
  checks: observations.length,
  verifierChecks: verifierCases.length,
  protectedRouteChecks: routeCases.length,
  verifiedRequests: observations.reduce((count, item) => count + item.verifiedRequests, 0),
  compatibilityDate,
  sourceSha256: sha256(source),
  protectedRouteSha256: sha256(routeSource),
  routeAdapterSha256: sha256(adapterSource),
  openNextContextSha256: sha256(cloudflareContextSource),
  dependencyLockSha256: sha256(lock),
  workerConfigSha256: sha256(config),
  joseVersion: await packageVersion('jose'),
  esbuildVersion: await packageVersion('esbuild'),
  miniflareVersion: await packageVersion('miniflare'),
  workerdVersion: await packageVersion('workerd', miniflareRequire),
  openNextVersion: JSON.parse(
    await readFile(
      resolve(dirname(require.resolve('@opennextjs/cloudflare')), '../../package.json'),
      'utf8',
    ),
  ).version,
  elapsedMs: Math.round(performance.now() - start),
  scope:
    'Actual local workerd Web Crypto and native global fetch, including the real protected GET export, its route adapter, and installed OpenNext context API; every outbound call intercepted by an in-memory synthetic provider.',
  protectedRouteScope:
    'Direct GET export execution; synthetic clock and Cloudflare context, real auth singleton without injection. Body-bearing POST fixtures call the GET export directly; Next/Payload HTTP routing is checked separately.',
  realProviderRequests: 0,
  paidAiCalls: 0,
  realFirebaseProviderFlow: 'NOT_RUN',
  observations,
}
const reportPath = resolve(root, '.qa/firebase-client/runtime.json')
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log(
  `PASS ${observations.length} actual workerd Firebase client auth checks; zero provider or AI calls.`,
)
