# Status

Last updated: 2026-10-23.

Update this file in the same pull request as the change it describes. A pull request that leaves it stale is not ready for review.

The snapshot below is from `gh issue list`, `gh pr list`, and `git log` on `AIKitLLC/cloudflare-admin-template` on 2026-10-23 around 18:40 [CT](https://en.wikipedia.org/wiki/Central_Time_Zone). `main` is `703d7b1`. Acronyms are defined in [Acronyms](#acronyms) at the end of this file.

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
| `0180b63` | #29 | Admin stack v1: [RBAC](https://en.wikipedia.org/wiki/Role-based_access_control) and the permission matrix, field-level audit trail, row-level scope, system parameters, background jobs, and the OpenNext Worker build (from #11–#15, #18, #19, now closed). |
| `533abcb` | #30 | Admin hardening 1: first admin from `pnpm admin:create` only ([CLI](https://en.wikipedia.org/wiki/Command-line_interface)), `Secure` / `SameSite=Lax` admin cookies in production, per-[IP](https://en.wikipedia.org/wiki/IP_address) throttling of sign-in, forgot-password, reset-password, and refresh-token (migration `20261017_105600_login_throttle`), required Cloudflare Access for `/admin` and `/api/users/*`, and homepage cleanup. |
| `53fa735` | #31 | Security patch: Next.js 16.4.1, every `sharp` at 0.35.5 or later, `packageManager` `pnpm@10.33.4`. Closes #34. |
| `0c0a719` | #33 | Security patch: Payload 3.91.0, `undici` 7.29.1, migration `20261017_133958_payload_3_91_security`. Closes #35 and #36. |
| `abad182` | #32 | First-run admin setup from the web (`src/auth/first-admin-setup.ts`, hidden collection `setup-state`, migration `20261017_144000_setup_state`). Closes #37. |
| `29262dd` | #39 | This status page refreshed after #29 and #30. Closes #38. |
| `63ee819` | #41 | Deploy-button inputs (`JOBS_INTERNAL_SECRET` active in `.env.example`, descriptions in `package.json`) and the isolated demo rollout guide `docs/demo-deployment.md`. Refs #40. |
| `703d7b1` | #48 | This status page refreshed after #41. |

## Toolchain and CI

- Node 22 (`.nvmrc`). `package.json` `engines`: Node `>=22.14.0`, pnpm `^9 || ^10 || ^11`. `packageManager` is `pnpm@10.33.4`, and the `ci` workflow installs the same release.
- Pinned stack in `pnpm-lock.yaml`: Payload `3.91.0`, Next.js `16.4.1`, React `19.3.0`, `@opennextjs/cloudflare` `1.20.11`, Wrangler `4.116.0`, TypeScript `6.0.3`, Vitest `5.0.1`, Playwright `1.63.0`. `pnpm.overrides` resolves every `sharp` to `0.35.5` or later and every `undici` 7.x below `7.29.1` to `7.29.1`.
- `pnpm ci:local` runs `scripts/ci-local.sh`: frozen install, `typecheck`, `typecheck:firebase`, `lint`, unit tests (`tests/unit`), integration tests (`tests/int`), `next build`, and the OpenNext Worker bundle. `--maxWorkers N` caps test parallelism. It needs no secrets and no Cloudflare account, and it deploys nothing.
- `.github/workflows/ci.yml` runs the same script in job `verify` on every pull request and on pushes to `main`. Runner `ubuntu-24.04`, Node from `.nvmrc`, actions pinned by commit SHA, `contents: read`.
- `.github/workflows/architecture.yml` (added by #27, tightened by #28) runs a report-only architecture analysis on pull requests as an inline, hash-locked job. See `AGENTS.md`.
- Playwright E2E tests (`tests/e2e`) are not part of `ci:local` or CI yet.

## Open pull requests

| Pull request | Title | Issue | Base | State |
| --- | --- | --- | --- | --- |
| This change | Recovery path when first-run setup is left incomplete | #47 | `main` | Draft |

#11–#15, #18, and #19 were closed as superseded by #29. #20 (plugin split, base `integration/admin-stack`) was closed on 2026-10-23; that work is on hold.

## Merge order

A maintainer decides the merge order. Do not merge any pull request without maintainer approval.

#31, #33, #32, #39, #41, and #48 were merged in that order.

## Deploy prerequisites

Agents do not run these. Do not deploy, do not log in to Cloudflare, and do not set secrets from an agent.

On `main` today:

- `wrangler.jsonc` still has the D1 `database_id` placeholder `DATABASE_ID`. Create the D1 database and R2 bucket and fill in the ids first (README, Deployment).
- `PAYLOAD_SECRET` is a Worker secret (`package.json` `cloudflare.bindings`, `.env.example`), not a var in `wrangler.jsonc`.
- Apply the migrations in `src/migrations` (listed in `src/migrations/index.ts`, the latest is `20261017_144000_setup_state`) to the target D1 database with `pnpm run deploy:database` or `pnpm payload migrate`. Local `pnpm dev` is not a substitute.
- Create the first admin on the `/admin` setup screen right after deploy, or with `pnpm admin:create`; setting up Cloudflare Access first is recommended. Cloudflare Access in front of `/admin` and `/api/users/*` is required in production. See `docs/admin-access.md`, and add the WAF rate limiting rule described there.
- Firebase native clients are off by default (`FIREBASE_CLIENT_ENABLED` = `"false"`, empty project values in `wrangler.jsonc`). The first owner is set by an operator with `scripts/bootstrap-client-security-owner.mjs`. See `docs/firebase-client-auth.md`.
- Workers plan: the README note on Workers plans is the source. Worker size is limited to 64 MiB uncompressed on both Free and Paid plans. A local build is about 15.7 MiB uncompressed (about 3.6 MiB gzip; measured 2026-10-17 06:18 CT at commit `b6c8198` with `wrangler deploy --dry-run`), so bundle size alone does not require Workers Paid. CPU time per request and startup time have not been measured yet.

Also on `main` since #29: `PAYLOAD_PUBLIC_SERVER_URL` is required in production, `JOBS_INTERNAL_SECRET` is set with `wrangler secret put`, the `*/5 * * * *` cron runs due jobs, and the KV namespace and queues stay commented in `wrangler.jsonc`. Do not create placeholder resources in order to deploy.

## Open issues

Labels exist (`type:*`, `area:*`, `status:*`, `priority:*`). No milestones exist yet.

| Issue | Title | Labels | Pull request |
| --- | --- | --- | --- |
| #4 | IP whitelisting and scheduled access windows | `type:feature`, `area:admin`, `status:ready`, `priority:p1` | — (#30 added per-IP throttling and requires Cloudflare Access, but no allowlist or access windows) |
| #5 | Background job processing and queue monitoring | `type:feature`, `area:platform`, `status:blocked`, `priority:p1` | #29 (merged). Jobs table, monitor, retry, cron, and queue consumer code are on `main`. The `JOB_QUEUE` binding stays commented until an operator creates the queues. |
| #6 | Outbox notification system | `type:feature`, `area:collections`, `status:ready`, `priority:p1` | — |
| #7 | State machine and approval workflow | `type:feature`, `area:collections`, `status:ready`, `priority:p2` | — |
| #8 | Advanced data grid | `type:feature`, `area:admin`, `status:ready`, `priority:p2` | — |
| #10 | Safe script runner | `type:feature`, `area:admin`, `status:ready`, `priority:p2` | — |
| #46 | Bump vulnerable transitive dependencies reported by `pnpm audit --prod` | — | — |
| #47 | Recovery path when first-run setup is left incomplete | — | This change |
| #49 | Mandatory CI/CD deploy; no deploys from a local machine | — | — |
| #40 | Deploy-button inputs and isolated demo rollout | — | #41 (merged). Stays open until a demo deploy and sign-in check succeed and the demo URL is recorded. |
| #44 | nexus-crm as a vertical plugin for the admin template | `type:feature`, `area:admin`, `status:ready`, `priority:p1` | — |
| #45 | Decouple core features into in-code modules | `type:feature`, `area:admin`, `status:ready`, `priority:p1` | — |

Closed on 2026-10-17 as resolved by #29 (`0180b63`): #1 (RBAC and permission matrix), #2 (row-level scope), #3 (audit trail), and #9 (system parameters). Closed by #31: #34. Closed by #33: #35 and #36. Closed by #32: #37. Closed by #39: #38. #41 (merged) refs #40 but does not close it.

Proposed milestones, for a person with permission to create them:

- **M1 Foundation.** [RBAC](https://en.wikipedia.org/wiki/Role-based_access_control) (#1), row-level scope (#2), audit (#3), and these standards (#16).
- **M2 Operations.** Background jobs (#5), notification outbox (#6), system parameters (#9).
- **M3 Operator workflows.** Access windows (#4), state machine (#7), data grid (#8), script runner (#10).

## Known blockers

- D1 on `main` still uses the placeholder database id `DATABASE_ID`.
- Workers CPU time and startup time have not been measured on a deployed Worker.
- E2E tests do not run in CI.
- Cloudflare Queues for background jobs (#5) do not exist yet, so jobs run from the cron only.

## This change

Setup recovery for #47. `src/auth/first-admin-setup.ts` gains `interruptedUserId` / `completeInterrupted` on the setup state: when a first-run setup attempt died after creating its user (stale claim still stored, setup not completed, exactly one user), the next web setup attempt or `pnpm admin:create` run ensures that user holds the Super Admin role and marks setup complete, instead of refusing and leaving the CLI-on-an-empty-table as the only path. No new account is created, no password changes, the guard trigger and the one-first-admin guarantee are unchanged, and recovery never runs under a live claim, with more than one user, or after completion. Three unit tests cover the web recovery, the CLI recovery, and both refusal boundaries (`tests/unit/first-admin-setup.test.ts`). Recovery steps for every interrupted state, including the manual fallback, are documented in `docs/admin-access.md` and summarised in the README. This page refreshed in the same pull request (snapshot 2026-10-23, `main` at `703d7b1` before this change).

## Acronyms

| Acronym | Meaning |
| --- | --- |
| API | [Application programming interface](https://en.wikipedia.org/wiki/API) |
| CI | [Continuous integration](https://en.wikipedia.org/wiki/Continuous_integration) |
| CLI | [Command-line interface](https://en.wikipedia.org/wiki/Command-line_interface) |
| CMS | [Content management system](https://en.wikipedia.org/wiki/Content_management_system) |
| CPU | [Central processing unit](https://en.wikipedia.org/wiki/Central_processing_unit) |
| CT | [Central Time](https://en.wikipedia.org/wiki/Central_Time_Zone) |
| D1 | [Cloudflare D1](https://developers.cloudflare.com/d1/), Cloudflare's SQLite database (a product name) |
| E2E | [End-to-end testing](https://en.wikipedia.org/wiki/Software_testing#End-to-end_testing) |
| IP | [Internet Protocol address](https://en.wikipedia.org/wiki/IP_address) |
| KiB, MiB | [Kibibyte and mebibyte](https://en.wikipedia.org/wiki/Byte#Multiple-byte_units) |
| KV | [Cloudflare Workers KV](https://developers.cloudflare.com/kv/), a key-value store |
| MIT | [MIT License](https://opensource.org/license/mit) |
| R2 | [Cloudflare R2](https://developers.cloudflare.com/r2/), Cloudflare's object storage (a product name) |
| RBAC | [Role-based access control](https://en.wikipedia.org/wiki/Role-based_access_control) |
| SHA | [Secure Hash Algorithm](https://en.wikipedia.org/wiki/Secure_Hash_Algorithms); here, the Git commit hash |
| WAF | [Web application firewall](https://developers.cloudflare.com/waf/) |
