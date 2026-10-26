# End-to-end tests

Playwright drives a real Chromium against the built Worker on workerd (`wrangler dev --local`), with a local D1 and R2 that start empty on every run. That is the runtime that ships, so it catches what a Node dev server hides (D1 has no transactions, there is no `sharp`, admin cookies are `Secure`).

## Run

```bash
pnpm exec playwright install chromium   # once; on Linux add: pnpm exec playwright install-deps chromium
pnpm test:e2e
```

`pnpm test:e2e` starts `scripts/e2e/serve-worker.mjs` itself (Playwright `webServer`), which:

1. builds the OpenNext bundle (`E2E_SKIP_BUILD=1` reuses an existing `.open-next`),
2. wipes `.wrangler/e2e` and applies the Payload migrations to it,
3. serves the Worker on `http://127.0.0.1:8792` (`E2E_PORT` changes the port).

It needs no secrets and no Cloudflare account. It never touches `.wrangler/state`, the database `pnpm dev` uses. It refuses to start when the port is already in use, so a leftover server cannot answer for a new run.

A warm run takes about a minute on a developer machine: build and migrate, then the specs.

## Projects and order

One shared database, so `workers: 1`.

| Project | Specs | Why |
| --- | --- | --- |
| `first-admin` | `first-admin.e2e.spec.ts` | Needs an empty `users` table. Creates the admin and saves its session to `tests/e2e/.auth/admin.json` (git-ignored). Serial, no retries: a retry would find the admin already created. |
| `chromium` | every other spec | Depends on `first-admin`, so it is skipped if setup failed. Starts signed in as `e2eAdmin` (`tests/e2e/helpers/admin.ts`). |

A spec that needs to be signed out uses `test.use({ storageState: { cookies: [], origins: [] } })`.

## Writing a spec

- Use relative URLs; `baseURL` is the Worker.
- Assert behaviour: a status code, a message the visitor sees, a redirect. When a form posts to an API, wait for that response (`page.waitForResponse`) and check its status. A form submitted before React hydrates posts to the page itself and never reaches the API, so asserting only "still on the page" passes without testing anything.
- Do not use Playwright's `request` fixture for calls that need the admin session. The admin cookie is `Secure` and that client does not send it over `http`. Call `fetch` from the page (`page.evaluate`) instead.
- Specs that create users or trigger lockouts must use their own accounts, and a distinct `cf-connecting-ip` where throttling is involved, so they cannot lock out the shared admin.

## Windows

The OpenNext build bundles `sharp`'s native binary on Windows and fails. Run the suite on Linux, in WSL, or in CI. In WSL, clone the repository into the Linux filesystem (not `/mnt/c`) and install a Linux Node and pnpm.

## CI

Job `e2e` in `.github/workflows/ci.yml` runs on every pull request and push to `main`, in parallel with `verify`. On failure it uploads the Playwright report and `test-results`.
