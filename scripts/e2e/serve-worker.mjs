// Serves the built OpenNext Worker for the Playwright E2E suite: workerd through
// `wrangler dev --local`, on an empty local D1/R2 that this script owns.
//
// The state lives in .wrangler/e2e, not .wrangler/state, so a run never touches the
// database `pnpm dev` uses. It is wiped on every start so the first-admin spec always
// finds an empty `users` table.
//
// Needs no secrets and no Cloudflare account. Run `pnpm run build:worker:full` first, or
// let Playwright's webServer do it (E2E_SKIP_BUILD=1 reuses an existing .open-next).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

import { buildCloudflareWorker } from '../worker-build/build-cloudflare-worker.mjs'

const port = Number(process.env.E2E_PORT ?? 8792)
// `localhost`, not `127.0.0.1`: the Worker sees its own origin as `http://localhost:<port>` (Next builds
// `request.url` from it), and the client security settings API only accepts a write whose `Origin`
// equals that. A browser on `127.0.0.1` would be refused every time.
const origin = `http://localhost:${port}`
const secret = 'e2e-worker-secret'
const stateDir = join(process.cwd(), '.wrangler', 'e2e')
const wranglerConfig = join(stateDir, 'wrangler.json')

const env = {
  ...process.env,
  CI: 'true',
  NEXT_TELEMETRY_DISABLED: '1',
  WRANGLER_SEND_METRICS: 'false',
  PAYLOAD_SECRET: secret,
  // The built Worker runs with NODE_ENV=production and refuses to boot without a public
  // origin, so admin cookies cannot fall back to localhost:3000.
  PAYLOAD_PUBLIC_SERVER_URL: origin,
}

// A server left over from an earlier run would answer the suite with its old database.
if (await portInUse(port)) {
  console.error(`e2e: port ${port} is in use; stop the old server or set E2E_PORT`)
  process.exit(1)
}

if (process.env.E2E_SKIP_BUILD === '1' && existsSync('.open-next/worker.js')) {
  console.log('e2e: reusing the existing .open-next build')
} else {
  buildCloudflareWorker([])
}

rmSync(stateDir, { recursive: true, force: true })
mkdirSync(stateDir, { recursive: true })
// Same binding names and ids as wrangler.jsonc, so `wrangler dev` finds the tables the
// Payload CLI creates here. `remote: true` in wrangler.jsonc would open a Cloudflare
// session for the CLI, so it is left out.
//
// The two tools disagree on the layout: `wrangler dev --persist-to X` keeps its data in
// `X/v3`, while the Payload CLI's platform proxy uses the path it is given as the root. The
// CLI therefore gets `<state>/v3`, which is where the Worker reads.
writeFileSync(
  wranglerConfig,
  JSON.stringify({
    name: 'e2e',
    compatibility_date: '2025-08-15',
    compatibility_flags: ['nodejs_compat'],
    d1_databases: [{ binding: 'D1', database_name: 'my-app', database_id: 'DATABASE_ID' }],
    r2_buckets: [{ binding: 'R2', bucket_name: 'my-app' }],
  }),
)

const migrate = spawnSync('pnpm', ['payload', 'migrate'], {
  cwd: process.cwd(),
  env: {
    ...env,
    NODE_ENV: 'development',
    PAYLOAD_TEST_WRANGLER_CONFIG: wranglerConfig,
    PAYLOAD_TEST_STORAGE_DIR: join(stateDir, 'v3'),
  },
  encoding: 'utf8',
  shell: process.platform === 'win32',
  timeout: 180_000,
})
if (migrate.status !== 0) {
  console.error(`${migrate.stdout ?? ''}\n${migrate.stderr ?? ''}`.slice(-4000))
  process.exit(migrate.status ?? 1)
}
console.log('e2e: migrated the local D1')

const worker = spawn(
  'pnpm',
  [
    'exec',
    'wrangler',
    'dev',
    '--local',
    '--port',
    String(port),
    '--inspector-port',
    String(port + 1000),
    '--persist-to',
    stateDir,
    '--var',
    `PAYLOAD_SECRET:${secret}`,
    '--var',
    `PAYLOAD_PUBLIC_SERVER_URL:${origin}`,
    '--show-interactive-dev-session',
    'false',
  ],
  {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // Not detached: Playwright stops its webServer with a SIGKILL to this process group, which
    // cannot run a handler here. Staying in the group is what takes pnpm, wrangler and workerd
    // down with it; a detached child would outlive the run and hold the port and Playwright's pipes.
  },
)

// Direct SIGINT/SIGTERM (a terminal, a graceful Playwright shutdown). `wrangler dev` runs under
// pnpm, and under a shell on Windows, so Windows needs the whole tree killed.
function stop() {
  if (worker.pid === undefined || worker.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(worker.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    worker.kill('SIGTERM')
  }
}
process.on('SIGINT', () => {
  stop()
  process.exit(0)
})
process.on('SIGTERM', () => {
  stop()
  process.exit(0)
})
process.on('exit', stop)
worker.on('exit', (code) => process.exit(code ?? 0))

function portInUse(value) {
  return new Promise((resolve) => {
    const socket = connect({ port: value, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}
