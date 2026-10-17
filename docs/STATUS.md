# Status

Last updated: 2026-10-17.

Update this file in the same pull request as the change it describes. A pull request that leaves it stale is not ready for Tony.

The snapshot below is from `gh issue list`, `gh pr list`, and `git log` on `AIKitLLC/cloudflare-admin-template` on 2026-10-17. `main` is `0180b63`.

## What is on `main`

| Commit | Pull request | Change |
| --- | --- | --- |
| `80cea96` | — | Initial template: Payload CMS, Next.js, D1, R2, OpenNext. |
| `2246ef9` | #21 | Firebase native clients authenticate separately from Payload admins (`src/auth`, `GET /api/client/v1/me`). |
| `d29b5ee` | #22 | Owner-managed Firebase trust settings and per-client rate limits (`src/client-security`, `/admin/client-security`, migration `20261013_120000`). |
| `b16e98a` | #23 | MIT license (`LICENSE`, `"license": "MIT"` in `package.json`). |
| `5151642` | #24 | `scripts/ci-local.sh` (`pnpm ci:local`), `.github/workflows/ci.yml` (job `verify`), `.nvmrc` = `22`, `engines.node` = `>=22.14.0`, and the README note on Workers plans. |
| `cf8414d` | #25 | Lint cleanup; `pnpm lint` reports no warnings. |
| `c743610` | #27 | Agent and architecture standards (`AGENTS.md`, `.agents/skills`, `.cursor/rules`, this file, `docs/ARCHITECTURE.md`) and the inline, hash-locked `architecture.yml` job. Supersedes #17. |
| `5ed74c2` | #26 | Removes the starter template's sample route `src/app/my-route`. |
| `336277d` | #28 | Tighter `architecture.yml` permissions and failure reporting. |
| `0180b63` | #29 | Admin stack v1: RBAC and the permission matrix, field-level audit trail, row-level scope, system parameters, background jobs, and the OpenNext Worker build (from #11–#15, #18, #19, now closed). |

## Toolchain and CI

- Node 22 (`.nvmrc`). `package.json` `engines`: Node `>=22.14.0`, pnpm `^9 || ^10 || ^11`. `packageManager` is `pnpm@10.33.4`, and the `ci` workflow installs the same release.
- Pinned stack in `pnpm-lock.yaml`: Payload `3.91.0`, Next.js `16.4.1`, React `19.3.0`, `@opennextjs/cloudflare` `1.20.11`, Wrangler `4.116.0`, TypeScript `6.0.3`, Vitest `5.0.1`, Playwright `1.63.0`. `pnpm.overrides` resolves every `sharp` to `0.35.5` or later and every `undici` 7.x below `7.29.1` to `7.29.1`.
- `pnpm ci:local` runs `scripts/ci-local.sh`: frozen install, `typecheck`, `typecheck:firebase`, `lint`, unit tests (`tests/unit`), integration tests (`tests/int`), `next build`, and the OpenNext Worker bundle. `--maxWorkers N` caps test parallelism. It needs no secrets and no Cloudflare account, and it deploys nothing.
- `.github/workflows/ci.yml` runs the same script in job `verify` on every pull request and on pushes to `main`. Runner `ubuntu-24.04`, Node from `.nvmrc`, actions pinned by commit SHA, `contents: read`.
- `.github/workflows/architecture.yml` (added by #27, tightened by #28) runs a report-only architecture analysis on pull requests as an inline, hash-locked job. See `AGENTS.md`.
- Playwright E2E tests (`tests/e2e`) are not part of `ci:local` or CI yet.

## Open pull requests

| PR | Title | Base | State |
| --- | --- | --- | --- |
| #30 | feat: admin hardening 1 | `main` | This change; draft |
| #20 | feat: split admin features into Payload plugins | `integration/admin-stack` | Draft |

#11–#15, #18, and #19 were closed as superseded by #29. #20 still targets `integration/admin-stack` and was not part of #29.

## Merge order

Tony decides the merge order. Do not merge any pull request without his approval.

## Deploy prerequisites

Agents do not run these. Do not deploy, do not log in to Cloudflare, and do not set secrets from an agent.

On `main` today:

- `wrangler.jsonc` still has the D1 `database_id` placeholder `DATABASE_ID`. Create the D1 database and R2 bucket and fill in the ids first (README, Deployment).
- `PAYLOAD_SECRET` is a Worker secret (`package.json` `cloudflare.bindings`, `.env.example`), not a var in `wrangler.jsonc`.
- Apply the migrations in `src/migrations` (listed in `src/migrations/index.ts`, the latest is `20261017_133958_payload_3_91_security`) to the target D1 database with `pnpm run deploy:database` or `pnpm payload migrate`. Local `pnpm dev` is not a substitute.
- Create the first admin with `pnpm admin:create`. Cloudflare Access in front of `/admin` and `/api/users/*` is required in production. See `docs/admin-access.md`, and add the WAF rate limiting rule described there.
- Firebase native clients are off by default (`FIREBASE_CLIENT_ENABLED` = `"false"`, empty project values in `wrangler.jsonc`). The first owner is set by an operator with `scripts/bootstrap-client-security-owner.mjs`. See `docs/firebase-client-auth.md`.
- Workers plan: the README note on Workers plans is the source. Worker size is limited to 64 MiB uncompressed on both Free and Paid plans. A local build is about 15.7 MiB uncompressed (about 3.6 MiB gzip; measured 2026-10-17 06:18 CT at commit `b6c8198` with `wrangler deploy --dry-run`), so bundle size alone does not require Workers Paid. CPU time per request and startup time have not been measured yet.

Also on `main` since #29: `PAYLOAD_PUBLIC_SERVER_URL` is required in production, `JOBS_INTERNAL_SECRET` is set with `wrangler secret put`, the `*/5 * * * *` cron runs due jobs, and the KV namespace and queues stay commented in `wrangler.jsonc`. Do not create placeholder resources in order to deploy.

## Open issues

Labels exist (`type:*`, `area:*`, `status:*`, `priority:*`). No milestones exist yet.

| Issue | Title | Labels | Pull request |
| --- | --- | --- | --- |
| #1 | Dynamic RBAC and permission matrix | `type:feature`, `area:admin`, `status:in-review`, `priority:p0` | #29 (merged) |
| #2 | Row-level security and organizational data scoping | `type:feature`, `area:collections`, `status:in-review`, `priority:p0` | #29 (merged) |
| #3 | Granular audit trail and column-level change logging | `type:feature`, `area:collections`, `status:in-review`, `priority:p0` | #29 (merged) |
| #4 | IP whitelisting and scheduled access windows | `type:feature`, `area:admin`, `status:ready`, `priority:p1` | — |
| #5 | Background job processing and queue monitoring | `type:feature`, `area:platform`, `status:in-review`, `priority:p1` | #29 (merged) |
| #6 | Outbox notification system | `type:feature`, `area:collections`, `status:ready`, `priority:p1` | — |
| #7 | State machine and approval workflow | `type:feature`, `area:collections`, `status:ready`, `priority:p2` | — |
| #8 | Advanced data grid | `type:feature`, `area:admin`, `status:ready`, `priority:p2` | — |
| #9 | System parameters and configuration | `type:feature`, `area:collections`, `status:in-review`, `priority:p1` | #29 (merged) |
| #10 | Safe script runner | `type:feature`, `area:admin`, `status:ready`, `priority:p2` | — |

Proposed milestones, for a person with permission to create them:

- **M1 Foundation.** RBAC (#1), row-level scope (#2), audit (#3), and these standards (#16).
- **M2 Operations.** Background jobs (#5), notification outbox (#6), system parameters (#9).
- **M3 Operator workflows.** Access windows (#4), state machine (#7), data grid (#8), script runner (#10).

## Known blockers

- D1 on `main` still uses the placeholder database id `DATABASE_ID`.
- Workers CPU time and startup time have not been measured on a deployed Worker.
- E2E tests do not run in CI.

## This change

Pull request #30 (`feat/admin-hardening-1`, draft, base `main` `0180b63`):

- First-admin bootstrap through the CLI only: `pnpm admin:create` (`scripts/create-first-admin.mjs`) creates the first admin. Requests without a signed-in user cannot create users (`src/auth/first-admin.ts`), so the admin panel's create-first-user screen is intentionally unavailable.
- Production cookie settings: `users` auth cookies are `Secure` in production, `SameSite=Lax` (`src/auth/users-auth.ts`).
- Throttling for auth endpoints: per-IP counters in D1 for sign-in, forgot-password, reset-password, and refresh-token (`src/auth/login-throttle.ts`, hidden collection `login-throttle`, migration `20261017_105600_login_throttle`) plus Payload's per-account lockout. Production refuses requests without `CF-Connecting-IP` and refuses auth requests when the D1 binding is missing. Expired rows are deleted during writes.
- Docs: Cloudflare Access is required in production for `/admin` and `/api/users/*`; the WAF rule in `docs/admin-access.md` covers the same auth paths.
- Homepage cleanup: the editor file link is gone.
- `src/config/test-runtime.ts`: production ignores `PAYLOAD_TEST_WRANGLER_CONFIG` and `PAYLOAD_TEST_STORAGE_DIR`.
- `next.config.ts` sets `agentRules: false`, so `next dev` in tests no longer writes `AGENTS.md`.
- Bundle-size figures now carry the date and commit they were measured at.
