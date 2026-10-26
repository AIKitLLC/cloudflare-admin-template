import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { APIRequestContext } from '@playwright/test'

type Outcome = { status: number; message: string }

/** The Worker's local D1 file. Relative to the working directory, like `adminStorageState`. */
function databasePath(): string {
  const directory = join('.wrangler', 'e2e', 'v3', 'd1', 'miniflare-D1DatabaseObject')
  const files = readdirSync(directory).filter(
    (name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite',
  )
  if (files.length !== 1) {
    throw new Error(`Expected one D1 database in ${directory}, found ${files.length}`)
  }
  return join(directory, files[0])
}

/** The Worker writes this file too, so a read or write can briefly find it locked. */
async function withDatabase<T>(readOnly: boolean, run: (db: DatabaseSync) => T): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const db = new DatabaseSync(databasePath(), { readOnly })
    try {
      return run(db)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    } finally {
      db.close()
    }
  }
  throw lastError
}

/**
 * The reset token of a user, or null. There is no email adapter in the E2E Worker (it only logs
 * "Email attempted without being configured"), so the token is read where it is stored. Call it
 * after the forgot-password response has arrived.
 */
export async function storedResetToken(email: string): Promise<string | null> {
  return withDatabase(true, (db) => {
    const row = db
      .prepare('SELECT reset_password_token AS token FROM users WHERE email = ?')
      .get(email.toLowerCase()) as { token: string | null } | undefined
    return row?.token ?? null
  })
}

/** Moves the expiration of the user's reset token into the past. */
export async function expireResetToken(email: string): Promise<void> {
  await withDatabase(false, (db) => {
    db.prepare("UPDATE users SET reset_password_expiration = '2020-01-01T00:00:00.000Z' WHERE email = ?").run(
      email.toLowerCase(),
    )
  })
}

async function outcome(response: Awaited<ReturnType<APIRequestContext['post']>>) {
  const text = await response.text()
  try {
    const body = JSON.parse(text) as {
      message?: string
      token?: string
      errors?: { message: string }[]
    }
    return {
      status: response.status(),
      message: body.errors?.[0]?.message ?? body.message ?? '',
      sessionToken: body.token,
    }
  } catch {
    throw new Error(`${response.url()} answered ${response.status()} with: ${text.slice(0, 500)}`)
  }
}

/** `POST /api/users/forgot-password` from `ip`. Pass `token` to send it as a signed-in user. */
export async function requestRecovery(
  request: APIRequestContext,
  { email, ip, token }: { email: string; ip: string; token?: string },
): Promise<Outcome> {
  const { status, message } = await outcome(
    await request.post('/api/users/forgot-password', {
      headers: { 'cf-connecting-ip': ip, ...(token ? { authorization: `JWT ${token}` } : {}) },
      data: { email },
    }),
  )
  return { status, message }
}

/** `POST /api/users/reset-password` from `ip`. */
export async function resetPassword(
  request: APIRequestContext,
  { token, password, ip }: { token: string; password: string; ip: string },
): Promise<Outcome & { sessionToken: string | undefined }> {
  return outcome(
    await request.post('/api/users/reset-password', {
      headers: { 'cf-connecting-ip': ip },
      data: { token, password },
    }),
  )
}
