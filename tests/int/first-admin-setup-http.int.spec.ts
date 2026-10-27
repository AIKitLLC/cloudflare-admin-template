// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformProxy } from 'wrangler'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// First-run admin setup end to end: a `next dev` server on its own empty D1/R2 state, so
// the `users` table starts empty, unlike the shared integration database.
const PORT = 3467
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'first-run-setup-password-123'

type D1 = {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => {
      first: <T>() => Promise<T | null>
      all: <T>() => Promise<{ results: T[] }>
      run: () => Promise<unknown>
    }
  }
}

let directory = ''
let server: ChildProcess | undefined
let output = ''
let platform: PlatformProxy<{ D1: D1 }> | undefined

function runtimeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PAYLOAD_SECRET: 'first-run-setup-test-secret',
    PAYLOAD_ALLOWED_ORIGINS: BASE,
    PAYLOAD_TEST_WRANGLER_CONFIG: join(directory, 'wrangler.json'),
    PAYLOAD_TEST_STORAGE_DIR: join(directory, 'state'),
    ...extra,
  }
}

/** `form` posts like the admin panel's form: multipart with a `_payload` JSON field. */
function setup(email: string, ip: string, origin: string | null = BASE, form = false) {
  const fields = { email, password: PASSWORD, 'confirm-password': PASSWORD }
  const body = new FormData()
  body.set('_payload', JSON.stringify(fields))
  return fetch(`${BASE}/api/users/first-register`, {
    method: 'POST',
    headers: {
      ...(origin ? { origin } : {}),
      'cf-connecting-ip': ip,
      ...(form ? {} : { 'content-type': 'application/json' }),
    },
    body: form ? body : JSON.stringify(fields),
  })
}

function db(): D1 {
  return platform!.env.D1
}

async function count(query: string): Promise<number> {
  const row = await db().prepare(query).bind().first<{ n: number }>()
  return Number(row?.n ?? 0)
}

async function superAdminUsers(): Promise<string[]> {
  const { results } = await db()
    .prepare(
      `SELECT u.email AS email FROM users u
       JOIN users_rels r ON r.parent_id = u.id AND r.path = 'roles'
       JOIN roles ro ON ro.id = r.roles_id AND ro.slug = 'super-admin'`,
    )
    .bind()
    .all<{ email: string }>()
  return results.map((row) => row.email)
}

/** Next answers a server-component redirect with a 3xx or a NEXT_REDIRECT marker in a 200. */
async function adminPage(path: string): Promise<{ redirect: string | undefined; html: string }> {
  const response = await fetch(`${BASE}${path}`, { redirect: 'manual' })
  const html = await response.text()
  const location = response.headers.get('location') ?? undefined
  const marker = /NEXT_REDIRECT;[a-z]+;([^;"\\]+)/.exec(html)?.[1]
  return {
    redirect: location ?? marker ?? (html.includes('NEXT_REDIRECT') ? '?' : undefined),
    html,
  }
}

async function waitForServer() {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`Setup server exited: ${output.slice(-2000)}`)
    }
    try {
      const response = await fetch(`${BASE}/admin`, { redirect: 'manual' })
      if (response.status < 500) return
    } catch {
      // Still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Setup server did not start: ${output.slice(-2000)}`)
}

function adminCreate(email: string): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['admin:create', '--email', email, '--confirm'], {
      cwd: process.cwd(),
      env: runtimeEnv({
        NODE_ENV: 'development',
        PAYLOAD_MIGRATING: 'true',
        FIRST_ADMIN_PASSWORD: PASSWORD,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    child.stdout?.on('data', (chunk: Buffer) => (text += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (text += chunk.toString()))
    child.on('close', (code) => resolve({ code, text }))
  })
}

describe('first-run admin setup over HTTP', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'template-first-run-'))
    const config = {
      name: 'template-first-run-setup',
      compatibility_date: '2025-08-15',
      compatibility_flags: ['nodejs_compat'],
      d1_databases: [
        {
          binding: 'D1',
          database_name: 'first-run-only',
          database_id: '00000000-0000-0000-0000-000000000001',
        },
      ],
      r2_buckets: [{ binding: 'R2', bucket_name: 'first-run-only' }],
    }
    await writeFile(join(directory, 'wrangler.json'), JSON.stringify(config))
    server = spawn('pnpm', ['exec', 'next', 'dev', '--port', String(PORT)], {
      cwd: process.cwd(),
      detached: true,
      env: runtimeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    server.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    await waitForServer()
    const { getPlatformProxy } = await import('wrangler')
    platform = await getPlatformProxy<{ D1: D1 }>({
      configPath: join(directory, 'wrangler.json'),
      envFiles: [],
      remoteBindings: false,
      persist: { path: join(directory, 'state') },
    })
  }, 180000)

  afterAll(async () => {
    if (server?.pid !== undefined) {
      try {
        process.kill(-server.pid, 'SIGTERM')
      } catch {
        server.kill('SIGTERM')
      }
    }
    await platform?.dispose()
    if (directory) await rm(directory, { recursive: true, force: true })
  }, 60000)

  it('opens the create-first-user screen on an empty database', async () => {
    expect(await count('SELECT count(*) AS n FROM users')).toBe(0)
    // /admin -> /admin/login -> /admin/create-first-user while no user exists.
    const hops: string[] = []
    let path: string | undefined = '/admin'
    while (path && hops.length < 4 && !path.includes('create-first-user')) {
      path = (await adminPage(path)).redirect
      if (path) hops.push(path)
    }
    expect(hops.at(-1) ?? '', hops.join(' -> ')).toContain('/admin/create-first-user')
    const screen = await adminPage('/admin/create-first-user')
    expect(screen.redirect).toBeUndefined()
    expect(screen.html).toContain('create-first-user')
  }, 120000)

  it('refuses a setup request from another origin', async () => {
    const response = await setup('elsewhere@example.com', '192.0.2.30', 'https://other.invalid')
    expect(response.status).toBe(403)
    expect(await count('SELECT count(*) AS n FROM users')).toBe(0)
  })

  it('refuses a setup request without Origin, Sec-Fetch-Site, or Referer', async () => {
    const response = await setup('no-origin@example.com', '192.0.2.33', null)
    expect(response.status).toBe(403)
    expect(await count('SELECT count(*) AS n FROM users')).toBe(0)
  })

  it('lets exactly one of two concurrent requests become Super Admin', async () => {
    const emails = ['race-a@example.com', 'race-b@example.org']
    const responses = await Promise.all([
      setup(emails[0], '192.0.2.31'),
      setup(emails[1], '192.0.2.32', BASE, true),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
    expect(
      await count(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'setup_state_single_first_admin'",
      ),
    ).toBe(1)
    const winner = responses.findIndex((response) => response.status === 200)
    const body = (await responses[winner].json()) as { user?: { email?: string; id?: number } }
    expect(body.user?.email).toBe(emails[winner])
    expect(responses[winner].headers.get('set-cookie') ?? '').toContain('payload-token=')
    expect(await count('SELECT count(*) AS n FROM users')).toBe(1)
    expect(await superAdminUsers()).toEqual([emails[winner]])
    expect(
      await count('SELECT count(*) AS n FROM setup_state WHERE completed_at IS NOT NULL'),
    ).toBe(1)
    // Logged with the user ID and email domain, never the password.
    expect(output).toContain('First admin created')
    expect(output).not.toContain(PASSWORD)
    expect(output).not.toContain(emails[winner])
  }, 120000)

  it('closes the screen and the endpoint once setup has completed', async () => {
    expect((await adminPage('/admin/create-first-user')).redirect).toBeDefined()
    expect((await setup('late@example.com', '192.0.2.33')).status).toBe(403)
    expect(await count('SELECT count(*) AS n FROM users')).toBe(1)
  }, 120000)

  it('stays closed after every user is removed; admin:create still recovers', async () => {
    await db().prepare('DELETE FROM users').bind().run()
    expect(await count('SELECT count(*) AS n FROM users')).toBe(0)
    expect((await setup('reopen@example.com', '192.0.2.34')).status).toBe(403)
    expect(await count('SELECT count(*) AS n FROM users')).toBe(0)

    const runs = await Promise.all([
      adminCreate('cli-a@example.com'),
      adminCreate('cli-b@example.com'),
    ])
    const created = (run: { code: number | null; text: string }) =>
      run.code === 0 && run.text.includes('First admin created with user ID')
    const succeeded = runs.filter(created).length
    const detail = runs.map((run) => `${run.code}: ${run.text.slice(-2000)}`).join('\n---\n')
    // Never two users. Local D1 shared by separate processes can also fail both runs; the
    // failed run removes its user, so a plain retry then succeeds.
    expect(succeeded, detail).toBeLessThanOrEqual(1)
    expect(await count('SELECT count(*) AS n FROM users'), detail).toBe(succeeded)
    if (succeeded === 0) {
      // #76: this retry failed once on CI. Its output and the setup row say why next time (a claim
      // kept by a run whose cleanup failed stays live for 2 minutes and refuses the retry).
      const retry = await adminCreate('cli-retry@example.com')
      const state = await db()
        .prepare('SELECT claim_token, claimed_at, completed_at FROM setup_state')
        .bind()
        .first()
      expect(
        created(retry),
        `${detail}\n--- retry ${retry.code}: ${retry.text.slice(-2000)}\n--- setup_state: ${JSON.stringify(state)}`,
      ).toBe(true)
    }
    expect(await count('SELECT count(*) AS n FROM users')).toBe(1)
    const admins = await superAdminUsers()
    expect(admins.length).toBe(1)
    expect((await setup('after-cli@example.com', '192.0.2.35')).status).toBe(403)
  }, 300000)
})
