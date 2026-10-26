// Serves the built OpenNext Worker for the Playwright E2E suite: workerd through
// `wrangler dev --local`, on an empty local D1/R2 that this script owns.
//
// The state lives in .wrangler/e2e, not .wrangler/state, so a run never touches the
// database `pnpm dev` uses. It is wiped on every start so the first-admin spec always
// finds an empty `users` table.
//
// A second instance (port + 1, state in .wrangler/e2e-interrupted) serves the one spec that
// needs a database in the "just set up" state, which the shared database cannot give once the
// first-admin spec has completed setup. It starts first, so the main port answering means both
// are up. `E2E_EXTRA_INSTANCE=0` skips it.
//
// Needs no secrets and no Cloudflare account. Run `pnpm run build:worker:full` first, or
// let Playwright's webServer do it (E2E_SKIP_BUILD=1 reuses an existing .open-next).
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

import { buildCloudflareWorker } from '../worker-build/build-cloudflare-worker.mjs'

const port = Number(process.env.E2E_PORT ?? 8792)
const secret = 'e2e-worker-secret'
const logDir = join(process.cwd(), '.wrangler', 'e2e-logs')
const instances = [
  ...(process.env.E2E_EXTRA_INSTANCE === '0'
    ? []
    : [
        {
          name: 'interrupted',
          port: port + 1,
          stateDir: join(process.cwd(), '.wrangler', 'e2e-interrupted'),
          log: 'worker-interrupted.log',
        },
      ]),
  { name: 'main', port, stateDir: join(process.cwd(), '.wrangler', 'e2e'), log: 'worker.log' },
]

const baseEnv = {
  ...process.env,
  CI: 'true',
  NEXT_TELEMETRY_DISABLED: '1',
  WRANGLER_SEND_METRICS: 'false',
  PAYLOAD_SECRET: secret,
  // Do not let wrangler load `.env` as dev vars. This does not isolate a local run (the build bakes
  // `.env*` into the bundle, `payload migrate` loads `.env`, and `.dev.vars` is still read); see
  // docs/e2e.md.
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
}

// A server left over from an earlier run would answer the suite with its old database.
for (const instance of instances) {
  if (await portInUse(instance.port)) {
    console.error(`e2e: port ${instance.port} is in use; stop the old server or set E2E_PORT`)
    process.exit(1)
  }
}

if (process.env.E2E_SKIP_BUILD === '1' && existsSync('.open-next/worker.js')) {
  console.log('e2e: reusing the existing .open-next build')
} else {
  buildCloudflareWorker([])
}

mkdirSync(logDir, { recursive: true })
const workers = []

// Direct SIGINT/SIGTERM (a terminal, a graceful Playwright shutdown). `wrangler dev` runs under
// pnpm, and under a shell on Windows, so Windows needs the whole tree killed.
function stop() {
  for (const worker of workers) {
    if (worker.pid === undefined || worker.exitCode !== null) continue
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(worker.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      worker.kill('SIGTERM')
    }
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

for (const instance of instances) {
  await start(instance, instance !== instances.at(-1))
}

/** Wipes and migrates the instance's state, then runs `wrangler dev` on it. */
async function start({ name, port: instancePort, stateDir, log }, waitUntilReady) {
  // `localhost`, not `127.0.0.1`: the Worker sees its own origin as `http://localhost:<port>` (Next
  // builds `request.url` from it), and the client security settings API only accepts a write whose
  // `Origin` equals that. A browser on `127.0.0.1` would be refused every time.
  const origin = `http://localhost:${instancePort}`
  // The built Worker runs with NODE_ENV=production and refuses to boot without a public
  // origin, so admin cookies cannot fall back to localhost:3000.
  const env = { ...baseEnv, PAYLOAD_PUBLIC_SERVER_URL: origin }
  const wranglerConfig = join(stateDir, 'wrangler.json')

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
  console.log(`e2e: migrated the local D1 (${name})`)

  const workerLog = createWriteStream(join(logDir, log))
  const worker = spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '--local',
      '--ip',
      'localhost',
      '--port',
      String(instancePort),
      '--inspector-port',
      String(instancePort + 1000),
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
      // Piped so the log can also go to a file CI uploads when a run fails (see the pipes below).
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      // Not detached: Playwright stops its webServer with a SIGKILL to this process group, which
      // cannot run a handler here. Staying in the group is what takes pnpm, wrangler and workerd
      // down with it; a detached child would outlive the run and hold the port and Playwright's pipes.
    },
  )
  workers.push(worker)
  // Everything the Worker prints is kept in `.wrangler/e2e-logs/<log>` as well, outside the state
  // directory (which is wiped) and outside `test-results` (which Playwright empties). CI uploads it.
  worker.stdout.pipe(process.stdout)
  worker.stderr.pipe(process.stderr)
  worker.stdout.pipe(workerLog, { end: false })
  worker.stderr.pipe(workerLog, { end: false })
  // `close`, not `exit`: it fires after the child's output has been read, so a crash message is kept.
  worker.on('close', (code) => workerLog.end(() => process.exit(code ?? 0)))

  if (waitUntilReady) await untilAnswering(`${origin}/api/users/me`, worker)
}

/** Resolves once the URL answers with anything, so the next instance (and Playwright) start after it. */
async function untilAnswering(url, worker) {
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`e2e: the Worker for ${url} exited early`)
    try {
      await fetch(url, { signal: AbortSignal.timeout(60_000) })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error(`e2e: ${url} did not answer within 5 minutes`)
}

// `localhost` may resolve to `::1` first, so a stray server on either address counts.
async function portInUse(value) {
  const open = (host) =>
    new Promise((resolve) => {
      const socket = connect({ port: value, host })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
  return (await open('127.0.0.1')) || (await open('::1'))
}
