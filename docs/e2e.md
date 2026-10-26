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
| `interrupted-setup` | `interrupted-first-admin.e2e.spec.ts` | Needs a database in the "just set up" state, which the shared one cannot give once `first-admin` has completed setup. Runs against a second Worker (below), no `storageState`, serial, no retries: it mutates its own database. |
| `chromium` | every other spec | Depends on `first-admin`, so it is skipped if setup failed. Starts signed in as `e2eAdmin` (`tests/e2e/helpers/admin.ts`). |

## The second Worker

`serve-worker.mjs` also serves a second instance on port + 1 (8793, state in `.wrangler/e2e-interrupted`), built from the same `.open-next` bundle and started first, so the main port answering means both are up. `E2E_EXTRA_INSTANCE=0` skips it. The interrupted spec builds its state from a real first-register and then three statements on that database (`helpers/interrupted-setup.ts`: clear `completed_at`, set a dead `claim_token` with a chosen `claimed_at`, delete the user's role link); the 2-minute claim age is backdated, never waited out. Recovery runs before credentials are checked, so a retry with the wrong password or another email still finishes setup and then answers 401.

A spec that needs to be signed out uses `test.use({ storageState: { cookies: [], origins: [] } })`.

## Writing a spec

- Use relative URLs; `baseURL` is the Worker.
- Assert behaviour: a status code, a message the visitor sees, a redirect. When a form posts to an API, wait for that response (`page.waitForResponse`) and check its status. A form submitted before React hydrates posts to the page itself and never reaches the API, so asserting only "still on the page" passes without testing anything.
- Playwright's `request` fixture does not send the admin cookie: it is `Secure` and the client does not send such cookies over `http`. For API calls send `Authorization: JWT <token>` (`api()` in `tests/e2e/helpers/api.ts`, with `signInToken` or `adminToken`), or call `fetch` from the page (`page.evaluate`) to use the browser's session.
- Specs that create users or trigger lockouts must use their own accounts, and a distinct `cf-connecting-ip` where throttling is involved, so they cannot lock out the shared admin. `tests/e2e/helpers/sign-in.ts` has `uniqueIp()`, `uniqueEmail()`, `createUser()` (as the admin, over the API), `attemptSignIn()` and `signInThroughUi()`. A client-sent `cf-connecting-ip` overrides the one `wrangler dev` adds, and the browser helper sets it on the whole context. Generate them per attempt, not per file: CI retries a failing test, and a retry that reuses an address or email fails for the wrong reason.

## What is covered

| Flow | Spec |
| --- | --- |
| First-admin setup (screen, short password, mismatch, success, closed afterwards) | `first-admin.e2e.spec.ts` |
| Sign-in and sign-out, wrong password, unknown email, per-account lockout, per-IP throttle, successful sign-ins not counted, garbage and tampered session, token revoked after sign-out | `sign-in.e2e.spec.ts` |
| Forgot and reset password through the admin screens, unknown email answered like a known one, invalid, reused and expired tokens, a reset unlocking an account and ending earlier sessions, who may start recovery, per-IP throttling | `password-recovery.e2e.spec.ts` |
| Password length 12 to 256 on reset, create and update (by id and by query); a refused reset leaves the token valid and the old password working | `password-policy.e2e.spec.ts` |
| Roles and the permission matrix: what a role grants over the API and on the admin screens (nav, forbidden URLs), grants taking effect at once, a create grant needing the field grants, only the owner changing `role`, the only owner not demotable | `roles-rbac.e2e.spec.ts` |
| Recovery of an interrupted first-admin setup: finishes setup for the one existing user (also when the retry has the wrong password or another email), never takes over a live claim, never promotes anyone when two users exist | `interrupted-first-admin.e2e.spec.ts` |
| Admin page loads, homepage | `admin.e2e.spec.ts`, `frontend.e2e.spec.ts` |

Not covered yet: admin CRUD and Media, row scope, the client API. An expired session token is not covered either: forging one needs Payload's derived signing key.

## Roles, grants and the owner

`tests/e2e/helpers/access.ts` creates a role with exactly the permission keys a test needs (`createRole`, `setGrant`; ids are looked up by key, never hard-coded) and gives every role a unique slug. `tests/e2e/helpers/api.ts` is one REST call with an explicit `JWT` token and the status, message and body back. `helpers/media.ts` has a 1x1 `PNG` and `uploadMedia`. `ensureOwner` returns the one client security owner, `e2e-owner@example.com`. No API makes a first owner, so it is created as a Super Admin and promoted with one `UPDATE` on the local D1 file (`helpers/database.ts`, shared with the reset-token helpers). It must stay the only owner, because the "final owner cannot be demoted" case depends on it, and no test deletes or edits `e2eAdmin` or the owner. If a regression ever let a test create a second owner, `ensureOwner` fails loudly for every later spec that uses it, so look for the first failing owner test.

## Reset tokens and the database file

The E2E Worker has no email adapter; it only logs that an email was attempted, without the link. `tests/e2e/helpers/recovery.ts` therefore reads the reset token from the Worker's local D1 file (`.wrangler/e2e/v3/d1/miniflare-D1DatabaseObject/*.sqlite`) with `node:sqlite`, read-only for reads (the owner promotion and the token expiry are the only writes), retrying briefly when the file is locked. Call it after the forgot-password response has arrived. Payload issues no new token for a user right after a reset, so a test must not recover the same user twice; every test creates its own.

Payload's reset screen refuses a submit made within about half a second of the last keystroke ("Please correct invalid fields." and no request). `submitResetForm` in the recovery spec repeats the click until the request goes out. `form[data-form-ready="true"]` is true before this settles, so it is not a substitute.

## Windows

The OpenNext build bundles `sharp`'s native binary on Windows and fails. Run the suite on Linux, in WSL, or in CI. In WSL, clone the repository into the Linux filesystem (not `/mnt/c`) and install a Linux Node and pnpm.

## CI

Job `e2e` in `.github/workflows/ci.yml` runs on every pull request and push to `main`, in parallel with `verify`. On failure it uploads the Playwright report and `test-results`.
