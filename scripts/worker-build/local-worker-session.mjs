import { spawn } from 'node:child_process'

const port = 8791
const origin = `http://127.0.0.1:${port}`
const secret = 'local-worker-check-secret'

export async function withLocalWorker(run) {
  const child = spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '--local',
      '--port',
      String(port),
      '--inspector-port',
      '9231',
      '--var',
      `PAYLOAD_SECRET:${secret}`,
      '--show-interactive-dev-session',
      'false',
    ],
    {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
        PAYLOAD_SECRET: secret,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let logs = ''
  const capture = (chunk) => {
    logs += chunk.toString()
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  try {
    await waitForReady(child, () => logs)
    return await run({
      dispatch: (path) => follow(path),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\n${logs.slice(-4000)}`)
  } finally {
    await stop(child)
  }
}

async function follow(path) {
  let current = path
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetch(`${origin}${current}`, {
      redirect: 'manual',
      headers: { accept: 'text/html,application/json' },
      signal: AbortSignal.timeout(60_000),
    })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, `${origin}${current}`).pathname
      continue
    }
    return {
      path: current,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      body: await response.text(),
    }
  }
  throw new Error(`Too many redirects from ${path}`)
}

function waitForReady(child, readLogs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('wrangler dev did not become ready'))
    }, 120_000)
    const poll = setInterval(() => {
      if (readLogs().includes('Ready on')) {
        clearInterval(poll)
        clearTimeout(timer)
        resolve()
      }
      if (child.exitCode !== null) {
        clearInterval(poll)
        clearTimeout(timer)
        reject(new Error(`wrangler dev exited ${child.exitCode}`))
      }
    }, 200)
  })
}

async function stop(child) {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      resolve()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
