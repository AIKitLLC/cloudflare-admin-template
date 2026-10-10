// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRequire = createRequire(join(process.cwd(), 'package.json'))
const wranglerPackage = projectRequire.resolve('wrangler/package.json')
const wranglerRequire = createRequire(wranglerPackage)
const { Miniflare } = wranglerRequire('miniflare')

const workerLogs: string[] = []
const wranglerBin = join(
  dirname(wranglerPackage),
  JSON.parse(readFileSync(wranglerPackage, 'utf8')).bin.wrangler,
)

function run(command: string, args: string[], timeout: number): string {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, CI: 'true', PAYLOAD_SECRET: secret, WRANGLER_SEND_METRICS: 'false' },
    encoding: 'utf8',
    timeout,
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (result.status !== 0) {
    throw new Error(output.slice(-4000))
  }
  return output
}

const secret = process.env.PAYLOAD_SECRET || 'test-secret-for-local-runs'

describe('worker build', () => {
  it(
    'bundles one OpenNext worker, dry-runs without queues, and runs queue and scheduled handlers',
    async () => {
      run(process.execPath, ['scripts/opennext-cloudflare.mjs', 'build'], 540_000)

      const handler = readFileSync('.open-next/server-functions/default/handler.mjs', 'utf8')
      expect(handler).toContain('endsWith("/server/preview-props.json")')
      expect(handler).toContain('drizzle-kit is not bundled into the Cloudflare Worker')
      const hostFallback = 'headers.host || new URL(result.internalEvent.url).host'
      expect(readFileSync('.open-next/middleware/handler.mjs', 'utf8')).toContain(hostFallback)

      const outdir = mkdtempSync(join(tmpdir(), 'jobs-worker-'))
      const dryRun = run(
        process.execPath,
        [wranglerBin, 'deploy', '--dry-run', '--outdir', outdir, '--keep-vars'],
        120_000,
      )
      expect(dryRun).toContain('--dry-run: exiting now.')
      expect(dryRun).not.toContain('placeholder-jobs-dlq')
      expect(dryRun).not.toContain('env.JOB_QUEUE')
      const size = dryRun.match(/Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/)
      expect(size).toBeTruthy()
      const gzipKib = Number(size?.[2])
      expect(gzipKib).toBeGreaterThan(0)
      expect(gzipKib).toBeLessThan(10 * 1024)

      const workerPath = join(outdir, 'custom-worker.js')
      const bundled = readFileSync(workerPath, 'utf8')
      expect(bundled).toContain('jobs.internal')
      expect(bundled).toContain(hostFallback)
      expect(bundled.match(/drizzle-kit is not bundled into the Cloudflare Worker/g)?.length).toBe(1)

      const entryPath = join(outdir, 'entry.js')
      writeFileSync(
        entryPath,
        `process.env.PAYLOAD_PUBLIC_SERVER_URL ||= 'https://admin.example.com'
process.env.PAYLOAD_SECRET ||= ${JSON.stringify(secret)}
import worker from './custom-worker.js'
if (!worker?.fetch) throw new Error('worker default export missing')
export default worker
`,
      )
      const wasm = [...bundled.matchAll(/from "\.\/([^"]+\.wasm)"/g)].map((match) => match[1])
      const modules = [
        { type: 'ESModule', path: entryPath },
        { type: 'ESModule', path: workerPath },
        ...wasm.map((name) => ({ type: 'CompiledWasm' as const, path: join(outdir, name) })),
      ]

      const mf = new Miniflare({
        unsafeTriggerHandlers: true,
        unsafeRuntimeEnv: {
          PAYLOAD_PUBLIC_SERVER_URL: 'https://admin.example.com',
          PAYLOAD_SECRET: secret,
        },
        modulesRoot: outdir,
        modules,
        compatibilityDate: '2025-08-15',
        compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
        d1Databases: { D1: 'jobs-proof' },
        r2Buckets: ['R2'],
        bindings: {
          JOBS_INTERNAL_SECRET: 'placeholder-jobs-internal-secret',
          PAYLOAD_PUBLIC_SERVER_URL: 'https://admin.example.com',
          PAYLOAD_SECRET: secret,
        },
        assets: {
          directory: join(process.cwd(), '.open-next/assets'),
          binding: 'ASSETS',
          routerConfig: { has_user_worker: true },
        },
        queueProducers: { JOB_QUEUE: 'jobs-proof' },
        queueConsumers: { 'jobs-proof': { maxBatchSize: 1, maxBatchTimeout: 0 } },
      })

      const consoleError = console.error.bind(console)
      console.error = (...args: unknown[]) => {
        workerLogs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
        consoleError(...args)
      }

      try {
        const cron = encodeURIComponent('*/5 * * * *')
        const first = await mf.dispatchFetch(
          `http://localhost/cdn-cgi/handler/scheduled?cron=${cron}&time=${Date.now()}`,
        )
        expect(first.status).toBe(200)

        const leaked = await mf.dispatchFetch('https://admin.example.com/jobs-worker', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-jobs-internal': 'placeholder-jobs-internal-secret',
            'x-forwarded-host': 'jobs.internal',
          },
          body: JSON.stringify({ kind: 'scheduled', payload: {} }),
        })
        expect(leaked.status).toBe(404)

        const db = await mf.getD1Database('D1')
        await db
          .prepare(
            `INSERT INTO jobs (name, payload, status, idempotency_key, max_attempts, attempt)
             VALUES ('system.ping', '{"note":"worker"}', 'PENDING', 'proof-ping', 1, 0)`,
          )
          .run()
        const second = await mf.dispatchFetch(
          `http://localhost/cdn-cgi/handler/scheduled?cron=${cron}&time=${Date.now()}`,
        )
        expect(second.status).toBe(200)
        const rows = await db.prepare(`SELECT status, logs FROM jobs WHERE idempotency_key = 'proof-ping'`).all()
        expect(rows.results?.[0]?.status).toBe('SUCCESS')
        expect(String(rows.results?.[0]?.logs)).toContain('ping worker')

        const queued = await db
          .prepare(
            `INSERT INTO jobs (name, payload, status, idempotency_key, max_attempts, attempt)
             VALUES ('system.ping', '{"note":"queue"}', 'PENDING', 'proof-queue', 1, 0)`,
          )
          .run()
        const queuedId = queued.meta.last_row_id
        const queue = await mf.getQueueProducer('JOB_QUEUE')
        await queue.send({ jobId: queuedId })
        await waitForStatus(db, 'proof-queue', 'SUCCESS')
        const queuedRow = await db
          .prepare(`SELECT logs FROM jobs WHERE idempotency_key = 'proof-queue'`)
          .all()
        expect(String(queuedRow.results?.[0]?.logs)).toContain('ping queue')

        await queue.send({ jobId: 'not-an-integer' })
        await queue.send({ jobId: 999999 })
        await waitForLog('non-integer jobId')
        const missing = await db.prepare('SELECT id FROM jobs WHERE id = 999999').all()
        expect(missing.results ?? []).toHaveLength(0)
      } finally {
        console.error = consoleError
        await mf.dispose()
      }
    },
    600_000,
  )
})

type ProofDb = {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => {
      all: () => Promise<{ results?: Array<Record<string, unknown>> }>
    }
    all: () => Promise<{ results?: Array<Record<string, unknown>> }>
  }
}

async function waitForStatus(db: ProofDb, key: string, status: string): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 20_000) {
    const rows = await db.prepare('SELECT status FROM jobs WHERE idempotency_key = ?').bind(key).all()
    if (rows.results?.[0]?.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`job ${key} did not reach ${status}`)
}

async function waitForLog(fragment: string): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    if (workerLogs.some((line) => line.includes(fragment))) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`missing worker log ${fragment}\n${workerLogs.join('\n').slice(-2000)}`)
}
