import type { Plugin } from 'payload'

import { SystemParameters } from './collections/SystemParameters'

export const adminParams = (): Plugin => (incoming) => {
  const collections = [...(incoming.collections ?? [])]
  if (!collections.some((collection) => collection.slug === SystemParameters.slug)) {
    collections.push(SystemParameters)
  }
  return {
    ...incoming,
    collections,
  }
}
