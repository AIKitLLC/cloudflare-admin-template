import type { CollectionAfterChangeHook, CollectionSlug, PayloadRequest } from 'payload'

import { relationId } from '@aikit/admin-rbac'
import { MAX_SCOPE_DEPTH } from '../constants'
import { runStatement } from '../sql/run-statement'
import { sql } from '../sql/scope-sql'
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
 * A move with a stored path rewrites this node and every descendant in one prefix-swap
 * UPDATE. A move whose stored path is null rebuilds the subtree from parent links in one
 * statement, because there is no prefix to swap. D1 applies each statement atomically.
 *
 * Two overlapping moves can interleave. The parent write and this hook are not one
 * transaction, so each request can read a prefix the other request then replaces.
 * The later statement wins and can leave a descendant on the path it computed.
 * Running the move again repairs a prefix swap. A null path is repaired by the rebuild.
 */
export const syncScopePath: CollectionAfterChangeHook = async ({
  collection,
  doc,
  previousDoc,
  req,
}) => {
  const slug = collection?.slug
  const table = slug ? SCOPE_TABLES[slug] : undefined
  if (!slug || !table) {
    return doc
  }
  const record = doc as PathDoc
  const previous = previousDoc as PathDoc | undefined
  const desired = await desiredScopePath(req, slug, record)
  const previousPath = previous?.scopePath ?? undefined
  if (previous && !previousPath) {
    await rebuildSubtree(req, table, record.id, desired)
  } else if (previousPath && previousPath !== desired) {
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

async function rebuildSubtree(
  req: PayloadRequest,
  table: string,
  id: number | string,
  scopePath: string,
): Promise<void> {
  const quoted = sql.raw(`"${table}"`)
  await runStatement(
    req,
    sql`WITH RECURSIVE subtree(id, scope_path, depth) AS (
      SELECT ${id}, ${scopePath}, 0
      UNION ALL
      SELECT child.id, subtree.scope_path || child.id || '/', subtree.depth + 1
      FROM ${quoted} AS child
      INNER JOIN subtree ON child.parent_id = subtree.id
      WHERE subtree.depth < ${MAX_SCOPE_DEPTH}
    )
    UPDATE ${quoted}
    SET scope_path = subtree.scope_path
    FROM subtree
    WHERE ${quoted}.id = subtree.id`,
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
