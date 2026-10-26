import { defineConfig, devices } from '@playwright/test'

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
import 'dotenv/config'

const port = Number(process.env.E2E_PORT ?? 8792)
// `localhost`, see scripts/e2e/serve-worker.mjs.
const baseURL = `http://localhost:${port}`

/** Written by the first-admin spec, reused by every spec that needs a signed-in admin. */
export const adminStorageState = 'tests/e2e/.auth/admin.json'

/**
 * The suite runs against the built Worker on workerd with a local D1/R2 that
 * `scripts/e2e/serve-worker.mjs` wipes and migrates on every start. See docs/e2e.md.
 *
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests/e2e',
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* One shared database, so specs must not race each other. */
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL,
    /* first-admin runs with retries: 0 and gates every other spec, so a retry-only trace would
       never exist for the failure that matters most. See https://playwright.dev/docs/trace-viewer */
    trace: 'retain-on-failure',
  },
  projects: [
    {
      // Needs the empty `users` table, so it runs first and creates the admin the rest reuse.
      name: 'first-admin',
      testMatch: /first-admin\.e2e\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
    {
      name: 'chromium',
      testIgnore: /first-admin\.e2e\.spec\.ts/,
      dependencies: ['first-admin'],
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        storageState: adminStorageState,
      },
    },
  ],
  webServer: {
    command: 'node scripts/e2e/serve-worker.mjs',
    url: `${baseURL}/api/users/me`,
    // A reused server would already have an admin, which the first-admin spec cannot use.
    reuseExistingServer: false,
    // Covers the OpenNext build on a cold runner; wrangler dev logs go to the test output.
    timeout: 15 * 60 * 1000,
    stdout: 'pipe',
    stderr: 'pipe',
    // Lets serve-worker.mjs run its own cleanup; Playwright's default is an immediate SIGKILL.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
})
