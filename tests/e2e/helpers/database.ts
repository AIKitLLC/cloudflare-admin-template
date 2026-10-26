import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** The Worker's local D1 file. Relative to the working directory, like `adminStorageState`. */
export function databasePath(): string {
  const directory = join('.wrangler', 'e2e', 'v3', 'd1', 'miniflare-D1DatabaseObject')
  const files = readdirSync(directory).filter(
    (name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite',
  )
  if (files.length !== 1) {
    throw new Error(`Expected one D1 database in ${directory}, found ${files.length}`)
  }
  return join(directory, files[0])
}

/** `SQLITE_BUSY` (5) or `SQLITE_LOCKED` (6), including their extended codes. */
function isLockError(error: unknown): boolean {
  const { errcode, message } = error as { errcode?: number; message?: string }
  if (typeof errcode === 'number') return (errcode & 0xff) === 5 || (errcode & 0xff) === 6
  return /database (table )?is locked|database is busy/i.test(message ?? '')
}

/** The Worker writes this file too, so a read or write can briefly find it locked. */
export async function withDatabase<T>(readOnly: boolean, run: (db: DatabaseSync) => T): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const db = new DatabaseSync(databasePath(), { readOnly })
    try {
      return run(db)
    } catch (error) {
      // Only a lock is worth waiting for; a missing table or a bad statement fails at once.
      if (!isLockError(error)) throw error
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    } finally {
      db.close()
    }
  }
  throw lastError
}
