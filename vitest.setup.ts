import type { CollectionConfig } from 'payload'
import { afterAll } from 'vitest'

import { AuditSubjects } from './tests/helpers/AuditSubjects'
import { WorkNotes } from './tests/helpers/WorkNotes'
import {
  disposeLocalIntegrationRuntime,
  startLocalIntegrationRuntime,
} from './tests/int/local-runtime'

// Read by src/payload.config.ts on first import. Keeps the test collections out
// of the production config and out of generated types.
;(globalThis as typeof globalThis & { __payloadTestCollections?: CollectionConfig[] }).__payloadTestCollections =
  [AuditSubjects, WorkNotes]

// Setup finishes before app config imports. No real env files or remote bindings are used.
await startLocalIntegrationRuntime()
afterAll(disposeLocalIntegrationRuntime)
