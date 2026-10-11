import type { PayloadRequest } from 'payload'

import { type ScopeSql } from './scope-sql'

type StatementRunner = {
  execute: (args: { drizzle?: unknown; sql?: ScopeSql }) => Promise<unknown>
  drizzle?: unknown
}

export async function runStatement(req: PayloadRequest, statement: ScopeSql): Promise<void> {
  const db = req.payload.db as StatementRunner
  await db.execute({ drizzle: db.drizzle, sql: statement })
}
