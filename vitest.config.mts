import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    // Node, not jsdom. Booting Payload loads Wrangler, and esbuild rejects jsdom's
    // TextEncoder because its Uint8Array is a different realm.
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/int/**/*.int.spec.ts'],
    // Local D1 is one SQLite file. Parallel files race on schema push and writes.
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
})
