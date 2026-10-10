import { sql } from '../sql/scope-sql'
import type { CollectionAfterChangeHook, CollectionSlug, PayloadRequest } from 'payload'

import { relationId } from '../../access/relation-id'
import { SKIP_SCOPE_PATH_CONTEXT } from '../constants'
import { runStatement } from '../sql/run-statement'
import { childScopePath, rootScopePath } from '../where/where-path-contains'

type PathDoc = {
  id: number | string
  parent?: unknown
  scopePath?: string | null
}

const SCOPE_TABLES: Record<string, string> = {
  organizations: 'organizations',
  branches: 'branches',
  'data-classes': 'data_classes',
}

/**
 * Stores `/rootId/.../id/` so a filter can match a node and its descendants with one LIKE
 * per direct assignment. The value is derived from `parent` after the row exists.
 *
 * A move rewrites this node and every descendant in one UPDATE. D1 has no transaction
 * around Payload hooks, so a per-node walk could leave a subtree half-moved. One
 * statement is atomic. It does not set `skipScopePath` on the request.
 */
export const syncScopePath: CollectionAfterChangeHook = async ({
  collection,
  context,
  doc,
  previousDoc,
  req,
}) => {
  if (
    context?.[SKIP_SCOPE_PATH_CONTEXT] === true ||
    req.context?.[SKIP_SCOPE_PATH_CONTEXT] === true
  ) {
    return doc
  }
  const slug = collection?.slug
  const table = slug ? SCOPE_TABLES[slug] : undefined
  if (!slug || !table) {
    return doc
  }
  const record = doc as PathDoc
  const previous = previousDoc as PathDoc | undefined
  const desired = await desiredScopePath(req, slug, record)
  const previousPath = previous?.scopePath ?? undefined
  if (previousPath && previousPath !== desired) {
    await swapScopePrefix(req, table, previousPath, desired)
  } else if ((record.scopePath ?? undefined) !== desired) {
    await writeScopePath(req, table, record.id, desired)
  }
  record.scopePath = desired
  return doc
}

async function desiredScopePath(
  req: PayloadRequest,
  slug: string,
  record: PathDoc,
): Promise<string> {
  const parentId = relationId(record.parent)
  if (!parentId) {
    return rootScopePath(record.id)
  }
  const parent = (await req.payload.findByID({
    collection: slug as CollectionSlug,
    id: parentId,
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })) as PathDoc | null
  const parentPath = parent?.scopePath || rootScopePath(parentId)
  return childScopePath(parentPath, record.id)
}

async function swapScopePrefix(
  req: PayloadRequest,
  table: string,
  oldPrefix: string,
  newPrefix: string,
): Promise<void> {
  if (!oldPrefix.startsWith('/') || !oldPrefix.endsWith('/') || oldPrefix.length < 3) {
    return
  }
  const start = oldPrefix.length + 1
  await runStatement(
    req,
    sql`UPDATE ${sql.raw(`"${table}"`)}
      SET scope_path = ${newPrefix} || substr(scope_path, ${start})
      WHERE scope_path LIKE ${likePrefix(oldPrefix)} ESCAPE '\\'`,
  )
}

async function writeScopePath(
  req: PayloadRequest,
  table: string,
  id: number | string,
  scopePath: string,
): Promise<void> {
  await runStatement(
    req,
    sql`UPDATE ${sql.raw(`"${table}"`)}
      SET scope_path = ${scopePath}
      WHERE id = ${id}`,
  )
}

function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}
