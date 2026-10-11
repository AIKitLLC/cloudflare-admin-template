import 'dotenv/config'

import type { CollectionConfig } from 'payload'

import { AuditSubjects } from './tests/helpers/AuditSubjects'
import { WorkNotes } from './tests/helpers/WorkNotes'

process.env.PAYLOAD_SECRET ||= 'test-secret-for-local-runs'

// Read by src/payload.config.ts on first import. Keeps the test collection out
// of the production config and out of generated types.
;(globalThis as typeof globalThis & { __payloadTestCollections?: CollectionConfig[] }).__payloadTestCollections =
  [AuditSubjects, WorkNotes]
