import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildCloudflareWorker } from './build-cloudflare-worker.mjs'
import { withLocalWorker } from './local-worker-session.mjs'

const dryRunTimeoutMs = 120_000
const buildTimeoutNote = 'worker build, dry-run, and local serve'

test(
  buildTimeoutNote,
  async () => {
    buildCloudflareWorker([])
    const outdir = mkdtempSync(join(tmpdir(), 'worker-dry-run-'))
    const dryRun = spawnSync(
      'pnpm',
      ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', outdir, '--keep-vars'],
      {
        cwd: process.cwd(),
        env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
        encoding: 'utf8',
        timeout: dryRunTimeoutMs,
      },
    )
    const output = `${dryRun.stdout ?? ''}\n${dryRun.stderr ?? ''}`
    assert.equal(dryRun.status, 0, output.slice(-4000))
    assert.match(output, /--dry-run: exiting now/)
    const size = output.match(/Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/)
    assert.ok(size, output.slice(-2000))
    const rawKib = Number(size[1])
    const gzipKib = Number(size[2])
    assert.ok(rawKib > 0 && gzipKib > 0)
    assert.ok(
      rawKib < 64 * 1024,
      `uncompressed bundle ${rawKib} KiB exceeds the 64 MiB Worker limit`,
    )
    console.log(`Total Upload: ${rawKib} KiB / gzip: ${gzipKib} KiB`)
    assert.ok(
      gzipKib > 3 * 1024,
      'README tells operators to use Workers Paid when gzip exceeds 3 MiB',
    )

    // Int tests push the schema in dev mode and leave a payload-migrations row
    // with batch -1. The next production boot treats that row as a prompt and
    // calls process.exit(0) when nobody can confirm it. Start from an empty
    // local D1 so this check does not depend on whichever suite ran last.
    // Stay out of NODE_ENV=production here: the Payload CLI uses the local
    // platform proxy, and production would open a remote binding.
    rmSync(join(process.cwd(), '.wrangler/state/v3/d1'), { recursive: true, force: true })
    const migrate = spawnSync('pnpm', ['payload', 'migrate'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
        PAYLOAD_SECRET: 'local-worker-check-secret',
        PAYLOAD_PUBLIC_SERVER_URL: 'http://127.0.0.1:8791',
      },
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(migrate.status, 0, `${migrate.stdout ?? ''}\n${migrate.stderr ?? ''}`.slice(-4000))

    await withLocalWorker(async ({ dispatch }) => {
      const admin = await dispatch('/admin')
      assert.equal(admin.status, 200, admin.body.slice(0, 500))
      assert.equal(admin.path.startsWith('/admin'), true, admin.path)
      assert.match(admin.body, /<html/i)
      assert.match(admin.body, /first user/i)
      assert.equal(admin.body.includes('Unexpected loadManifest'), false)

      const route = await dispatch('/my-route')
      assert.equal(route.status, 200, route.body.slice(0, 500))
      assert.deepEqual(JSON.parse(route.body), {
        message: 'This is an example of a custom route.',
      })
    })
  },
  { timeout: 600_000 },
)
