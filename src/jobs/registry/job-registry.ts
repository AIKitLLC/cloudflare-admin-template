import type { JobDefinition } from '../types'

const registry = new Map<string, JobDefinition<unknown>>()

export function registerJob(definition: JobDefinition<unknown>): void {
  if (definition.name.startsWith('test.') && process.env.NODE_ENV === 'production') {
    throw new Error(`Test job ${definition.name} cannot be registered in production.`)
  }
  const existing = registry.get(definition.name)
  if (existing && existing.execute !== definition.execute) {
    if (process.env.VITEST === 'true' && definition.name.startsWith('test.')) {
      registry.set(definition.name, definition)
      return
    }
    throw new Error(`Job ${definition.name} is already registered.`)
  }
  registry.set(definition.name, definition)
}

export function getJob(name: string): JobDefinition<unknown> | undefined {
  if (name.startsWith('test.') && process.env.NODE_ENV === 'production') {
    return undefined
  }
  return registry.get(name)
}

export function listJobNames(): string[] {
  return [...registry.keys()]
    .filter((name) => !(name.startsWith('test.') && process.env.NODE_ENV === 'production'))
    .sort()
}
