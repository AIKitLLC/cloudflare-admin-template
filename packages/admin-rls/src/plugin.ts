import type { Plugin } from 'payload'

import { Branches } from './collections/Branches'
import { DataClasses } from './collections/DataClasses'
import { Organizations } from './collections/Organizations'
import { Records } from './collections/Records'
import { attachRowScopeHooks, ensureRowScopeRegistered } from './register-row-scope'

export const adminRls = (): Plugin => (incoming) => {
  ensureRowScopeRegistered()
  const collections = [...(incoming.collections ?? [])]
  const slugs = new Set(collections.map((collection) => collection.slug))
  for (const collection of [Organizations, Branches, DataClasses, Records]) {
    if (!slugs.has(collection.slug)) {
      collections.push(collection)
    }
  }
  attachRowScopeHooks(collections)
  return {
    ...incoming,
    collections,
  }
}
