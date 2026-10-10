import type { CollectionSlug, PayloadRequest } from 'payload'

import { BRANCHES_SLUG, DATA_CLASSES_SLUG, ORGANIZATIONS_SLUG } from '../constants'
import type { BranchNode, ScopeCatalog, ScopeNode } from '../types'
import {
  readCatalogPromise,
  storeCatalogPromise,
  clearCatalogPromise,
} from '../cache/scope-request-cache'
import { relationId } from '../../access/relation-id'

type CatalogDoc = {
  id: number | string
  parent?: unknown
  organization?: unknown
}

export async function loadScopeCatalog(req: PayloadRequest): Promise<ScopeCatalog> {
  const cached = readCatalogPromise(req)
  if (cached) {
    return cached
  }
  const pending = queryScopeCatalog(req)
  storeCatalogPromise(req, pending)
  try {
    return await pending
  } catch (error) {
    clearCatalogPromise(req)
    throw error
  }
}

async function queryScopeCatalog(req: PayloadRequest): Promise<ScopeCatalog> {
  const [organizations, branches, dataClasses] = await Promise.all([
    findNodes(req, ORGANIZATIONS_SLUG),
    findNodes(req, BRANCHES_SLUG),
    findNodes(req, DATA_CLASSES_SLUG),
  ])
  return {
    organizations: toNodes(organizations),
    branches: toBranches(branches),
    dataClasses: toNodes(dataClasses),
  }
}

async function findNodes(req: PayloadRequest, slug: string): Promise<CatalogDoc[]> {
  const result = await req.payload.find({
    collection: slug as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
  })
  return result.docs as CatalogDoc[]
}

function toNodes(docs: CatalogDoc[]): Map<string, ScopeNode> {
  const nodes = new Map<string, ScopeNode>()
  for (const doc of docs) {
    const id = String(doc.id)
    const parentId = relationId(doc.parent)
    nodes.set(id, parentId ? { id, parentId } : { id })
  }
  return nodes
}

function toBranches(docs: CatalogDoc[]): Map<string, BranchNode> {
  const nodes = new Map<string, BranchNode>()
  for (const doc of docs) {
    const id = String(doc.id)
    const parentId = relationId(doc.parent)
    const organizationId = relationId(doc.organization)
    nodes.set(id, {
      id,
      ...(parentId ? { parentId } : {}),
      ...(organizationId ? { organizationId } : {}),
    })
  }
  return nodes
}
