import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** The Worker's local D1 file. Relative to the working directory, like `adminStorageState`. */
export function databasePath(stateDir = join('.wrangler', 'e2e')): string {
  const directory = join(stateDir, 'v3', 'd1', 'miniflare-D1DatabaseObject')
  const files = readdirSync(directory).filter(
    (name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite',
  )
  if (files.length !== 1) {
    throw new Error(`Expected one D1 database in ${directory}, found ${files.length}`)
  }
  return join(directory, files[0])
}

/** The Worker writes this file too, so a read or write can briefly find it locked. */
export async function withDatabase<T>(
  readOnly: boolean,
  run: (db: DatabaseSync) => T,
  stateDir?: string,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const db = new DatabaseSync(databasePath(stateDir), { readOnly })
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
