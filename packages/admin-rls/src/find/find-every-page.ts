import type { CollectionSlug, PayloadRequest, Where } from 'payload'

import { D1_SAFE_PAGE_SIZE } from '../constants'

export async function findEveryPage<T>(
  req: PayloadRequest,
  collection: string,
  where?: Where,
): Promise<T[]> {
  const docs: T[] = []
  let page = 1
  for (;;) {
    const result = await req.payload.find({
      collection: collection as CollectionSlug,
      depth: 0,
      limit: D1_SAFE_PAGE_SIZE,
      overrideAccess: true,
      page,
      pagination: true,
      req,
      where,
    })
    docs.push(...(result.docs as T[]))
    if (!result.hasNextPage || result.docs.length === 0) {
      return docs
    }
    page += 1
  }
}
