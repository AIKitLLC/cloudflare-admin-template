import { afterAll } from 'vitest'

import {
  disposeLocalIntegrationRuntime,
  startLocalIntegrationRuntime,
} from './tests/int/local-runtime'

// Setup finishes before app config imports. No real env files or remote bindings are used.
await startLocalIntegrationRuntime()
afterAll(disposeLocalIntegrationRuntime)
