import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIRST_ADMIN_PASSWORD_ENV = 'FIRST_ADMIN_PASSWORD'
export const FIRST_ADMIN_PASSWORD_MIN_LENGTH = 12

const usage = 'Usage: FIRST_ADMIN_PASSWORD=<password> pnpm admin:create --email <email> --confirm'

export function parseFirstAdminArguments(args, env = process.env) {
  const rest = args[0] === '--' ? args.slice(1) : args
  if (rest.length !== 3 || rest[0] !== '--email' || rest[2] !== '--confirm') throw new Error(usage)
  const email = rest[1].trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email is required.')
  const password = env[FIRST_ADMIN_PASSWORD_ENV]
  if (typeof password !== 'string' || password.length < FIRST_ADMIN_PASSWORD_MIN_LENGTH)
    throw new Error(
      `Set ${FIRST_ADMIN_PASSWORD_ENV} to a password of at least ${FIRST_ADMIN_PASSWORD_MIN_LENGTH} characters.`,
    )
  return { email, password }
}

/**
 * Operator first-admin bootstrap through the Payload Local API. It takes the same single-row
 * setup claim as the web setup screen, so concurrent runs create at most one user, and that
 * user holds the Super Admin role. Unlike the web screen it also works after setup has
 * completed, as long as the `users` table is empty again.
 */
export async function createFirstAdmin(payload, { email, password }) {
  const { createFirstAdminAccount } = await import('../src/auth/first-admin-setup.ts')
  return createFirstAdminAccount(payload, { email, password }, { source: 'cli' })
}

function payloadCLI() {
  try {
    return realpathSync(process.argv[1]).endsWith(path.join('payload', 'bin.js'))
  } catch {
    return false
  }
}

let stage = 'start'

async function main() {
  // The Payload CLI starts scripts without awaiting them, so a run whose event loop drains
  // early would otherwise end with exit code 0. Report it as a failure instead.
  process.once('beforeExit', () => {
    if (stage === 'done') return
    console.error(`admin:create stopped before it finished (${stage}). Run it again.`)
    process.exitCode = 1
  })
  const input = parseFirstAdminArguments(process.argv.slice(2))
  if (!payloadCLI())
    throw new Error(
      'Use the Payload CLI so the operator selects the configured environment explicitly.',
    )
  stage = 'loading config'
  const { getPayload } = await import('payload')
  const { default: config } = await import('../src/payload.config.ts')
  stage = 'starting Payload'
  const payload = await getPayload({ config })
  try {
    stage = 'creating the first admin'
    const user = await createFirstAdmin(payload, input)
    console.log(`First admin created with user ID ${user.id}.`)
  } finally {
    await payload.destroy()
  }
  stage = 'done'
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct || payloadCLI()) await main()
