import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function parseBootstrapArguments(args) {
  if (
    args.length !== 3 ||
    args[0] !== '--user-id' ||
    args[2] !== '--confirm' ||
    !/^[1-9]\d*$/.test(args[1])
  )
    throw new Error(
      'Usage: payload run scripts/bootstrap-client-security-owner.mjs -- --user-id <exact-user-id> --confirm',
    )
  const userId = Number(args[1])
  if (!Number.isSafeInteger(userId)) throw new Error('The user ID must be a positive safe integer.')
  return userId
}

/** Operator-only atomic initial claim. Never expose this function or its context to HTTP input. */
export async function bootstrapClientSecurityOwner(payload, userId) {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new Error('An exact existing user ID is required.')
  await payload.findByID({ collection: 'users', id: userId, depth: 0, overrideAccess: true })
  const binding = payload.db.binding
  if (!binding || typeof binding.prepare !== 'function')
    throw new Error('A configured D1 binding is required.')
  // The predicate and role update are one SQLite statement, so concurrent bootstrap jobs cannot both win.
  const result = await binding
    .prepare(
      "UPDATE users SET role = 'owner', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner')",
    )
    .bind(userId)
    .run()
  if (!result.success || result.meta?.changes !== 1) {
    const { APIError } = await import('payload')
    throw new APIError(
      'Initial bootstrap did not change a user: an owner exists or the selected user is unavailable.',
      409,
    )
  }
  return payload.findByID({ collection: 'users', id: userId, depth: 0, overrideAccess: true })
}

function payloadCLI() {
  try {
    return realpathSync(process.argv[1]).endsWith(path.join('payload', 'bin.js'))
  } catch {
    return false
  }
}

async function main() {
  const userId = parseBootstrapArguments(process.argv.slice(2))
  if (!payloadCLI())
    throw new Error(
      'Use the Payload CLI so the operator selects the configured environment explicitly.',
    )
  // Confirmation and exact ID are validated before loading any deployment configuration or binding.
  const { getPayload } = await import('payload')
  const { default: config } = await import('../src/payload.config.ts')
  const payload = await getPayload({ config })
  try {
    const user = await bootstrapClientSecurityOwner(payload, userId)
    console.log(`Client security owner initialized for user ID ${user.id}.`)
  } finally {
    await payload.destroy()
  }
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct || payloadCLI()) await main()
