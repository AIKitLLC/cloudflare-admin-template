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
 * Operator-only first-admin bootstrap through the Payload Local API. Refuses when any user
 * exists. The `users` afterChange hook gives the first user the Super Admin role.
 */
export async function createFirstAdmin(payload, { email, password }) {
  const { totalDocs } = await payload.count({ collection: 'users', overrideAccess: true })
  if (totalDocs > 0) {
    const { APIError } = await import('payload')
    throw new APIError('A user already exists. Create further users from the admin panel.', 409)
  }
  return payload.create({
    collection: 'users',
    data: { email, password },
    overrideAccess: true,
  })
}

function payloadCLI() {
  try {
    return realpathSync(process.argv[1]).endsWith(path.join('payload', 'bin.js'))
  } catch {
    return false
  }
}

async function main() {
  const input = parseFirstAdminArguments(process.argv.slice(2))
  if (!payloadCLI())
    throw new Error(
      'Use the Payload CLI so the operator selects the configured environment explicitly.',
    )
  const { getPayload } = await import('payload')
  const { default: config } = await import('../src/payload.config.ts')
  const payload = await getPayload({ config })
  try {
    const user = await createFirstAdmin(payload, input)
    console.log(`First admin created with user ID ${user.id}.`)
  } finally {
    await payload.destroy()
  }
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct || payloadCLI()) await main()
