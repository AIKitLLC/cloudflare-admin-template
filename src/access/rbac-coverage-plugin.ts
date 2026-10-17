import type { Config } from 'payload'

import { applyRbacToGlobal, applyRbacToUnwrappedCollection } from './cover-unwrapped'

export function rbacCoveragePlugin(config: Config): Config {
  for (const collection of config.collections ?? []) {
    applyRbacToUnwrappedCollection(collection)
  }
  for (const globalConfig of config.globals ?? []) {
    applyRbacToGlobal(globalConfig)
  }
  return config
}
