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
3. serves the Worker on `http://localhost:8792` (`E2E_PORT` changes the port).

It needs no secrets and no Cloudflare account. It never touches `.wrangler/state`, the database `pnpm dev` uses. It refuses to start when the port is already in use, so a leftover server cannot answer for a new run.

A warm run takes about a minute on a developer machine: build and migrate, then the specs.

## Projects and order

One shared database, so `workers: 1`.

| Project | Specs | Why |
| --- | --- | --- |
| `first-admin` | `first-admin.e2e.spec.ts` | Needs an empty `users` table. Creates the admin and saves its session to `tests/e2e/.auth/admin.json` (git-ignored). Serial, no retries: a retry would find the admin already created. |
| `interrupted-setup` | `interrupted-first-admin.e2e.spec.ts` | Needs a database in the "just set up" state, which the shared one cannot give once `first-admin` has completed setup. Runs against a second Worker (below), no `storageState`, serial. It mutates its own database, so it is configured without retries; a retry would still be safe because every case rebuilds its state first. |
| `chromium` | every other spec | Depends on `first-admin`, so it is skipped if setup failed. Starts signed in as `e2eAdmin` (`tests/e2e/helpers/admin.ts`). |

## The second Worker

`serve-worker.mjs` also serves a second instance on port + 1 (`http://localhost:8793`, state in `.wrangler/e2e-interrupted`, log in `.wrangler/e2e-logs/worker-interrupted.log`), built from the same `.open-next` bundle and started first, so the main port answering means both are up. `E2E_EXTRA_INSTANCE=0` skips it. The interrupted spec builds its state from a real first-register and then two statements on that database (`helpers/interrupted-setup.ts`: clear `completed_at` and set a dead `claim_token` with a chosen `claimed_at`, and delete the user's role link); the 2-minute claim age is backdated, never waited out. A refused web request (a live claim, or two users) still marks setup completed, so after an early retry only `pnpm admin:create` can finish it; the spec asserts that, which also proves the request reached the setup code. Recovery runs before credentials are checked, so a retry with the wrong password or another email still finishes setup and then answers 401.

A spec that needs to be signed out uses `test.use({ storageState: { cookies: [], origins: [] } })`.

## Writing a spec

- Use relative URLs; `baseURL` is the Worker.
- Assert behaviour: a status code, a message the visitor sees, a redirect. When a form posts to an API, wait for that response (`page.waitForResponse`) and check its status. A form submitted before React hydrates posts to the page itself and never reaches the API, so asserting only "still on the page" passes without testing anything.
- Playwright's `request` fixture has its own cookie jar, separate from the page's. Since the suite runs on `localhost` it sends a `Secure` session cookie from that jar (a storage state, or an earlier sign-in in the same test), which would authenticate a call meant to be anonymous. `api()` therefore sends an empty `cookie` header. For API calls send `Authorization: JWT <token>` (`api()` in `tests/e2e/helpers/api.ts`, with `signInToken` or `adminToken`), or call `fetch` from the page (`page.evaluate`) to use the browser's session.
- Specs that create users or trigger lockouts must use their own accounts, and a distinct `cf-connecting-ip` where throttling is involved, so they cannot lock out the shared admin. `tests/e2e/helpers/sign-in.ts` has `uniqueIp()`, `uniqueEmail()`, `createUser()` (as the admin, over the API), `attemptSignIn()` and `signInThroughUi()`. A client-sent `cf-connecting-ip` overrides the one `wrangler dev` adds, and the browser helper sets it on the whole context. Generate them per test (and per request where a throttle counts), not per file: CI retries a failing test, and a retry that reuses an address or email fails for the wrong reason.

## What is covered

| Flow | Spec |
| --- | --- |
| First-admin setup (screen, short password, mismatch, success, closed afterwards) | `first-admin.e2e.spec.ts` |
| Sign-in and sign-out, wrong password, unknown email, per-account lockout, per-IP throttle, successful sign-ins not counted, garbage and tampered session, token revoked after sign-out | `sign-in.e2e.spec.ts` |
| Forgot and reset password through the admin screens, unknown email answered like a known one, invalid, reused and expired tokens, a reset unlocking an account and ending earlier sessions, who may start recovery, per-IP throttling | `password-recovery.e2e.spec.ts` |
| Password length 12 to 256 on reset, create and update (by id and by query); a refused reset leaves the token valid and the old password working | `password-policy.e2e.spec.ts` |
| Roles and the permission matrix: what a role grants over the API and on the admin screens (nav, forbidden URLs), grants taking effect at once, a create grant needing the field grants, only the owner changing `role`, the only owner not demotable | `roles-rbac.e2e.spec.ts` |
| Users through the admin screens (create, duplicate and invalid email, edit, delete, a user deleting themselves, `users:delete` against a Super Admin) | `users-crud.e2e.spec.ts` |
| Media through the admin screens (upload with `alt`, served file, missing `alt`, edit, delete and its file, refused HTML and scripted SVG, duplicate file name) | `media.e2e.spec.ts` |
| The audit trail (an entry per create, update and delete with actor and IP, redacted secrets, no entry for a refused write, append-only, the Audit Logs screen) | `audit-trail.e2e.spec.ts` |
| Recovery of an interrupted first-admin setup: finishes setup for the one existing user (also when the retry has the wrong password or another email), never takes over a live claim, never promotes anyone when two users exist | `interrupted-first-admin.e2e.spec.ts` |
| Admin page loads, homepage (signed out and in, its links, a user without roles, signed out again after sign-out) | `admin.e2e.spec.ts`, `frontend.e2e.spec.ts` |
| Row scope (a scoped user sees and changes only records and users inside their organization, branch and data class: by list, id, screen, export and API; cannot widen their own scope; the scope tree refuses a used node and a cycle) | `row-scope.e2e.spec.ts` |
| Client security: the owner-only settings API (same-origin writes, preview, save, wrong digest, stale revision, rollback, the audit list), the settings panel, and what `GET /api/client/v1/me` answers while disabled and to missing or invalid credentials once enabled | `client-security.e2e.spec.ts` |

Not covered yet: a valid Firebase token (see Client security below). An expired session token is not covered either: forging one needs Payload's derived signing key.

## Roles, grants and the owner

`tests/e2e/helpers/access.ts` creates a role with exactly the permission keys a test needs (`createRole`, `setGrant`; ids are looked up by key, never hard-coded) and gives every role a unique slug. `tests/e2e/helpers/api.ts` is one REST call with an explicit `JWT` token and the status, message and body back. `helpers/media.ts` has a 1x1 `PNG` and `uploadMedia`. `ensureOwner` returns the one client security owner, `e2e-owner@example.com`. No API makes a first owner, so it is created as a Super Admin and promoted with one `UPDATE` on the local D1 file (`helpers/database.ts`, shared with the reset-token helpers). It must stay the only owner, because the "final owner cannot be demoted" case depends on it, and no test deletes or edits `e2eAdmin` or the owner. If a regression ever let a test create a second owner, `ensureOwner` fails loudly for every later spec that uses it, so look for the first failing owner test.

## Users, Media and the audit trail

- Never delete or edit the shared `e2eAdmin` or the owner: other full-access users exist, so the "last full-access holder" guard would not stop it and every later spec would lose its session.
- SQLite reuses the id of a deleted row, so an audit entry looked up by `collectionSlug` and `documentId` alone also returns an earlier document's history. `auditEntries` therefore takes `since`, an ISO time read before the test's first change.
- Payload renames a duplicate upload by incrementing a trailing number (`a-1.png` becomes `a-2.png`) and by adding `-1` otherwise, so `uniqueFilename` ends in a letter (`-pic`).
- On the create and edit screens, wait for `form[data-form-ready="true"]` before typing (earlier input is lost on hydration), open pages with `waitUntil: 'domcontentloaded'` (a `load` wait stalled twice in 30 runs), and treat the field error and the toast as equivalent: a later form-state answer can clear the field error.
- Delete from the screen: `button.popup-button`, `#action-delete`, `#confirm-action`.
## Row scope

Each test builds its own tree with `createScopeTree` (`helpers/scope.ts`: organizations A with child A1 and B, a branch in each, two data classes, four records, every slug and title unique), so a scoped user's unfiltered list is exactly that test's rows. A scoped role also needs the field-read keys (`scopedReaderRole` builds them from the catalog): without them `sort=title` is a 400 and documents come back empty. A limited users manager may only edit users whose role keys are a subset of the manager's, so the test's users are created without a role. Out of scope, a read by id is `404 Not Found` while a write is `403`; on the screen the list shows "The document with ID <id> could not be found".
## Client security

The Worker sees its own origin as `http://localhost:<port>` (Next builds `request.url` from it), and `/api/admin/client-security` accepts a write only when `Origin` equals that. A browser on `127.0.0.1` would be refused every time, so the harness serves and tests on `http://localhost:8792`. `--local-upstream` does not change what the route sees. The Worker listens on `127.0.0.1` only, while `localhost` can resolve to `::1` first, so `playwright.config.ts` pins Chromium (`--host-resolver-rules`) and the request client (`--dns-result-order=ipv4first`) to IPv4. Before that pin, one whole-suite run in about five lost the connection or stalled for 30 s in an unrelated spec; five runs in a row passed after it.

The settings are shared state. The spec puts revision 0's content back after every test (`restoreDefaults`, a rollback that adds a revision), so no test asserts an absolute revision number, and the history list is capped, so it is only used for its newest row.

Not covered: a valid App Check token and Firebase ID token, ownership of a record, and quota exhaustion. Verifying a token fetches signing keys from fixed Google URLs, a local Worker cannot serve keys of its own, and the product should not grow a test hook for it. Those cases stay with `pnpm test:firebase:runtime`, `pnpm test:api` and `tests/int/client-security.int.spec.ts`, which inject keys.

## Waiting for a form to be usable

Wait for `networkidle` after opening the login and create-first-user screens, not for `form[data-form-ready="true"]`. The marker is true earlier than the page is settled: with it, `first-admin` once never sent its first submit (a 30 s timeout waiting for the API) and the sign-in helper stalled two times in 285 runs on a reload or navigation, against none in 285 runs and about 200 earlier with `networkidle`. The forgot and reset screens do use the marker (they are not the ones that failed); the reset screen additionally refuses a submit within half a second of the last keystroke (above).

## Local runs and the Worker log

The config no longer loads a developer's `.env` (no `dotenv/config`), and wrangler is told not to load `.env` as dev vars (`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`). That does not isolate a local run: the OpenNext build bakes `.env`, `.env.production`, `.env.local` and `.env.production.local` into the bundle (`.open-next/cloudflare/next-env.mjs`, loaded at runtime with `??=`, so only `PAYLOAD_SECRET` and `PAYLOAD_PUBLIC_SERVER_URL`, passed with `--var`, win), `payload migrate` loads `.env` too, and wrangler still reads `.dev.vars`. To reproduce a CI run exactly, move those files away first. Everything the Worker prints is also written to `.wrangler/e2e-logs/worker.log` (the second Worker's to `worker-interrupted.log`), which CI uploads with the report and traces when a run fails.

## Reset tokens and the database file

The E2E Worker has no email adapter; it only logs that an email was attempted, without the link. `tests/e2e/helpers/recovery.ts` therefore reads the reset token from the Worker's local D1 file (`.wrangler/e2e/v3/d1/miniflare-D1DatabaseObject/*.sqlite`) with `node:sqlite`, read-only for reads (the owner promotion and the token expiry are the only writes), retrying briefly when the file is locked (`SQLITE_BUSY` or `SQLITE_LOCKED`; any other error fails at once). Call it after the forgot-password response has arrived. Payload issues no new token for a user right after a reset, so a test must not recover the same user twice; every test creates its own.

Payload's reset screen refuses a submit made within about half a second of the last keystroke ("Please correct invalid fields." and no request). `submitResetForm` in the recovery spec repeats the click until the request goes out. `form[data-form-ready="true"]` is true before this settles, so it is not a substitute.

## Windows

The OpenNext build bundles `sharp`'s native binary on Windows and fails. Run the suite on Linux, in WSL, or in CI. In WSL, clone the repository into the Linux filesystem (not `/mnt/c`) and install a Linux Node and pnpm.

## CI

Job `e2e` in `.github/workflows/ci.yml` runs on every pull request and push to `main`, in parallel with `verify`. On failure it uploads the Playwright report, `test-results` (traces) and the Worker logs (`.wrangler/e2e-logs/`, a hidden folder, hence `include-hidden-files`).

### Timings and the decision (15 runs on 2026-10-26, 32 to 93 tests)

| | Median | Range |
|---|---|---|
| `verify` job | 12 min | 9 to 13 min |
| `e2e` job | 3.8 min | 2.7 to 16 min |
| `pnpm test:e2e` step (build included) | 2.7 min | 2.1 to 3.9 min |
| OpenNext build inside it | about 65 s | 65 to 100 s |

The suite is not what varies: six runs took 10 to 16 minutes because `playwright install --with-deps` waited on a stalled Ubuntu mirror (368 to 786 s against about 15 s). So:

- **Every pull request runs the full suite.** The step takes under 4 minutes and `e2e` runs in parallel with `verify`, so no smoke subset is needed. The `apt` timeouts and the 8-minute step limit in `ci.yml` bound the mirror stalls.
- **No `.next/cache` cache.** The build is about a minute, so a cache could save less than the install stalls cost, and a stale build cache would be a new way to test the wrong code.

### Flaky tests

None of the 15 runs had a flaky or failed test (`N flaky` never appeared in the summary), so CI retries once, for infrastructure noise, and a test that needs the retry is a bug. Playwright prints the retried test as `flaky`; treat that as a failure to fix, not a pass. Turn on `failOnFlakyTests` in `playwright.config.ts` after ten consecutive runs of the current suite with none: the suite has 93 tests now, so that count starts at the first run after this change.
