# Status

Last updated: 2026-10-17.

Update this file in the same pull request as the change it describes. A pull request that leaves it stale is not ready for Tony.

The snapshot below is from `gh issue list`, `gh pr list`, and `git log` on `AIKitLLC/cloudflare-admin-template` on 2026-10-17. `main` is `336277d`.

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

## Toolchain and CI

- Node 22 (`.nvmrc`). `package.json` `engines`: Node `>=22.14.0`, pnpm `^9 || ^10 || ^11`.
- Pinned stack in `pnpm-lock.yaml`: Payload `3.82.1`, Next.js `16.4.0`, React `19.3.0`, `@opennextjs/cloudflare` `1.20.11`, Wrangler `4.116.0`, TypeScript `6.0.3`, Vitest `5.0.1`, Playwright `1.63.0`.
- `pnpm ci:local` runs `scripts/ci-local.sh`: frozen install, `typecheck`, `typecheck:firebase`, `lint`, unit tests (`tests/unit`), integration tests (`tests/int`), `next build`, and the OpenNext Worker bundle. `--maxWorkers N` caps test parallelism. It needs no secrets and no Cloudflare account, and it deploys nothing.
- `.github/workflows/ci.yml` runs the same script in job `verify` on every pull request and on pushes to `main`. Runner `ubuntu-24.04`, Node from `.nvmrc`, actions pinned by commit SHA, `contents: read`.
- `.github/workflows/architecture.yml` (added by #27, tightened by #28) runs a report-only architecture analysis on pull requests as an inline, hash-locked job. See `AGENTS.md`.
- Playwright E2E tests (`tests/e2e`) are not part of `ci:local` or CI yet.

## Open pull requests

| PR | Title | Base | State |
| --- | --- | --- | --- |
| — | feat: admin stack v1 (consolidates #11-#15, #18, #19) | `main` | This change; draft; supersedes #11–#15, #18, #19 |
| #20 | feat: split admin features into Payload plugins | `integration/admin-stack` | Draft |
| #19 | integration: admin stack (reference only, do not merge) | `main` | Draft |
| #18 | fix: make the OpenNext Cloudflare worker build succeed | `main` | Draft |
| #15 | feat: background jobs, queue consumer, and job monitor | #11 branch | Draft |
| #14 | feat: centralized system parameters with typed values and isolate cache | #11 branch | Draft |
| #13 | feat: row-level security and organizational data scoping | #11 branch | Draft |
| #12 | feat: field-level audit trail for collection changes | `main` | Draft |
| #11 | Add dynamic RBAC and the permission matrix | `main` | Draft |

This change consolidates #11–#15, #18, and #19 on top of current `main`; those pull requests stay open as references until it lands. #11, #12, #18, and #19 branch from `80cea96`, before #21–#25; #13–#15 stack on #11 and #20 on #19. Each of #11–#15 and #18 changes at least one file that #21/#22 also changed (`src/payload.config.ts`, plus `src/collections/Users.ts`, `src/migrations/index.ts`, `src/payload-types.ts`, or the admin import map). This change resolves those overlaps against `main`.

## Merge order

Tony decides the merge order. Do not merge any pull request without his approval. The order recorded on 2026-10-10 (#12, then #11, then #13/#14, then #15) predates #18–#25 and is being re-planned. Constraints that still hold:

- #13, #14, and #15 are stacked on the #11 branch. Merging one of them before #11 is on `main` would bring the #11 changes with it.
- #12 says its interim audit read rule must be replaced in the same change if it is combined with #11.

## Deploy prerequisites

Agents do not run these. Do not deploy, do not log in to Cloudflare, and do not set secrets from an agent.

On `main` today:

- `wrangler.jsonc` still has the D1 `database_id` placeholder `DATABASE_ID`. Create the D1 database and R2 bucket and fill in the ids first (README, Deployment).
- `PAYLOAD_SECRET` is a Worker secret (`package.json` `cloudflare.bindings`, `.env.example`), not a var in `wrangler.jsonc`.
- Apply the migrations in `src/migrations` (`20250929_111647`, `20261013_120000`) to the target D1 database with `pnpm run deploy:database` or `pnpm payload migrate`. Local `pnpm dev` is not a substitute.
- Firebase native clients are off by default (`FIREBASE_CLIENT_ENABLED` = `"false"`, empty project values in `wrangler.jsonc`). The first owner is set by an operator with `scripts/bootstrap-client-security-owner.mjs`. See `docs/firebase-client-auth.md`.
- Workers plan: the README note on Workers plans is the source. Worker size is limited to 64 MiB uncompressed on both Free and Paid plans. A local build is about 15.5 MiB uncompressed (about 3.6 MiB gzip), so bundle size alone does not require Workers Paid. CPU time per request and startup time have not been measured yet.

Named by open pull requests, and only relevant if they merge: `PAYLOAD_PUBLIC_SERVER_URL` (#11), `JOBS_INTERNAL_SECRET` via `wrangler secret put` and a `*/5 * * * *` cron (#15), and a KV namespace and queues that those pull requests leave commented (#14, #15). Do not create placeholder resources in order to deploy.

## Open issues

Labels exist (`type:*`, `area:*`, `status:*`, `priority:*`). No milestones exist yet.

| Issue | Title | Labels | Open pull request |
| --- | --- | --- | --- |
| #1 | Dynamic RBAC and permission matrix | `type:feature`, `area:admin`, `status:in-review`, `priority:p0` | #11 |
| #2 | Row-level security and organizational data scoping | `type:feature`, `area:collections`, `status:in-review`, `priority:p0` | #13 |
| #3 | Granular audit trail and column-level change logging | `type:feature`, `area:collections`, `status:in-review`, `priority:p0` | #12 |
| #4 | IP whitelisting and scheduled access windows | `type:feature`, `area:admin`, `status:ready`, `priority:p1` | — |
| #5 | Background job processing and queue monitoring | `type:feature`, `area:platform`, `status:in-review`, `priority:p1` | #15 |
| #6 | Outbox notification system | `type:feature`, `area:collections`, `status:ready`, `priority:p1` | — |
| #7 | State machine and approval workflow | `type:feature`, `area:collections`, `status:ready`, `priority:p2` | — |
| #8 | Advanced data grid | `type:feature`, `area:admin`, `status:ready`, `priority:p2` | — |
| #9 | System parameters and configuration | `type:feature`, `area:collections`, `status:in-review`, `priority:p1` | #14 |
| #10 | Safe script runner | `type:feature`, `area:admin`, `status:ready`, `priority:p2` | — |

Proposed milestones, for a person with permission to create them:

- **M1 Foundation.** RBAC (#1), row-level scope (#2), audit (#3), and these standards (#16).
- **M2 Operations.** Background jobs (#5), notification outbox (#6), system parameters (#9).
- **M3 Operator workflows.** Access windows (#4), state machine (#7), data grid (#8), script runner (#10).

## Known blockers

- The feature pull requests #11–#15 are drafts, stacked, and behind `main`.
- D1 on `main` still uses the placeholder database id `DATABASE_ID`.
- Workers CPU time and startup time have not been measured on a deployed Worker.
- E2E tests do not run in CI.

## This change

`feat/admin-stack-v1` (draft, base `main`) consolidates #11 (RBAC and the permission matrix), #12 (field-level audit trail), #13 (row-level scope), #14 (system parameters), #15 (background jobs and job monitor), #18 (OpenNext Worker build), and the #19 integration branch into one branch on top of `main` `336277d`, merged rather than rebased. It supersedes those pull requests, which stay open until it lands. The #12 interim audit read rule is replaced by the #11 permission check (`audit-logs:read`). The modules in `docs/ARCHITECTURE.md` "Target boundaries" (`src/access`, `src/rbac`, `src/audit`, `src/scope`, `src/system-parameters`, `src/jobs`) are added by this change. It needs Security review, then CTO review, before Tony decides on merging.
