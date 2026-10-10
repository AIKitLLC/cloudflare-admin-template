import type { CollectionAfterChangeHook, CollectionSlug, PayloadRequest } from 'payload'

import { relationId } from '../../access/relation-id'
import { MAX_SCOPE_DEPTH, SKIP_SCOPE_PATH_CONTEXT } from '../constants'
import { findEveryPage } from '../find/find-every-page'
import { childScopePath, rootScopePath } from '../where/where-path-contains'

type PathDoc = {
  id: number | string
  parent?: unknown
  scopePath?: string | null
}

/**
 * Stores `/rootId/.../id/` so a filter can match a node and its descendants with one LIKE
 * per direct assignment. The value is derived from `parent` after the row exists.
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
  if (!slug) {
    return doc
  }
  const record = doc as PathDoc
  const previous = previousDoc as PathDoc | undefined
  const desired = await desiredScopePath(req, slug, record)
  let stored = record.scopePath ?? undefined
  if (stored !== desired) {
    await writeScopePath(req, slug, record.id, desired)
    record.scopePath = desired
    stored = desired
  }
  const parentChanged = relationId(previous?.parent) !== relationId(record.parent)
  const pathChanged = (previous?.scopePath ?? undefined) !== stored
  if (previous && (parentChanged || pathChanged)) {
    await rewriteDescendants(req, slug, String(record.id), stored, 0)
  }
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

async function rewriteDescendants(
  req: PayloadRequest,
  slug: string,
  parentId: string,
  parentPath: string,
  depth: number,
): Promise<void> {
  if (depth >= MAX_SCOPE_DEPTH) {
    return
  }
  const children = await findEveryPage<PathDoc>(req, slug, { parent: { equals: parentId } })
  for (const child of children) {
    const next = childScopePath(parentPath, child.id)
    if (child.scopePath !== next) {
      await writeScopePath(req, slug, child.id, next)
    }
    await rewriteDescendants(req, slug, String(child.id), next, depth + 1)
  }
}

async function writeScopePath(
  req: PayloadRequest,
  slug: string,
  id: number | string,
  scopePath: string,
): Promise<void> {
  const alreadySet = req.context?.[SKIP_SCOPE_PATH_CONTEXT] === true
  await req.payload.update({
    collection: slug as 'organizations',
    id,
    data: { scopePath },
    depth: 0,
    overrideAccess: true,
    req,
    context: {
      [SKIP_SCOPE_PATH_CONTEXT]: true,
    },
  })
  if (!alreadySet && req.context) {
    delete req.context[SKIP_SCOPE_PATH_CONTEXT]
  }
}
