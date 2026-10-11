// Any setup scripts you might need go here

// Load .env files
import 'dotenv/config'

import type { CollectionConfig } from 'payload'

import { AuditSubjects } from './tests/helpers/AuditSubjects'

// Read by src/payload.config.ts on first import. Keeps the test collection out
// of the production config and out of generated types.
;(globalThis as typeof globalThis & { __payloadTestCollections?: CollectionConfig[] }).__payloadTestCollections =
  [AuditSubjects]
