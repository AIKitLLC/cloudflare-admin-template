import { registerJob } from './job-registry'
import type { JobDefinition } from '../types'

export function defineJob<TPayload>(definition: JobDefinition<TPayload>): JobDefinition<TPayload> {
  registerJob(definition as JobDefinition<unknown>)
  return definition
}
