# Status

Last updated: 2026-10-10.

Update this file in the same pull request as the change it describes. A pull request that leaves it stale is not ready for Tony.

The snapshot below is from `gh issue list` and `gh pr list` on `AIKitLLC/cloudflare-admin-template` on 2026-10-10. `main` is `80cea96`. The only commit on `main` is the initial template.

## Planned merge order

Tony's order. Do not merge any of these without his approval.

1. Build-fix pull request onto `main`. Named as the first merge. It was not in the open pull request list at this snapshot. `gh pr list --state all` returned only #11–#15, and `git branch -r` had no other heads. Re-check before merging. Do not guess a number.
2. #12, field-level audit trail. Closes #3. Base branch `main`. Draft. Merge this before #11. The pull request says the interim audit read rule must be replaced in the same change if the branch is rebased onto #11, and it must not merge after #11 while that interim rule remains.
3. #11, dynamic RBAC and the permission matrix. Closes #1. Base branch `main`. Draft.
4. #13 (row-level security, closes #2) and #14 (system parameters, closes #9). Both are drafts stacked on `cursor/rbac-permission-matrix-fc4f` (#11). They do not depend on each other. Merge both after #11 is on `main`.
5. #15, background jobs. Closes #5. Draft, stacked on #11. Merge after #11. It does not depend on #13 or #14.

#13, #14, and #15 say `Closes #N` in the body. GitHub has not registered those as closing references because their base branch is not `main`. #11 and #12 have registered closing references.

## Deploy prerequisites

Recorded from the open pull requests and the README. Agents do not run these. Do not deploy, do not log in to Cloudflare, and do not set secrets from an agent.

- `PAYLOAD_PUBLIC_SERVER_URL` must be set on the Worker before a production start. #11 throws at startup when it is missing. `next build` and the Payload CLI still fall back to `http://localhost:3000`.
- `pnpm payload migrate` against the target D1 database before that deploy. Local `pnpm dev` pushes the Drizzle schema and is not a substitute. The open feature pull requests add their own migrations: audit logs (#12), `payload_kv` and the RBAC tables (#11), row scope (#13), system parameters (#14), and jobs (#15). Apply the migrations that belong to the pull requests that actually merged.
- `JOBS_INTERNAL_SECRET` is set with `wrangler secret put JOBS_INTERNAL_SECRET` before the jobs cron from #15 runs. Do not put that value in `wrangler.jsonc` vars. #15 refuses a missing value, the `.env.example` placeholder, or a secret shorter than 32 characters. `wrangler secret put` deploys a version. A person runs it, not an agent.
- Workers paid plan. The README already says the OpenNext bundle is over 3 MB. #15 measured a `wrangler deploy --dry-run` (it uploads nothing) of about 6495 KiB gzip on that branch, and about 5788 KiB gzip on the #11 base with the same OpenNext build. Both are over the Workers free-plan script limit of 3 MiB and under the paid 10 MiB limit. This repository does not buy that plan.

Also from those pull requests, still not a license to create resources:

- Leave the #15 `queues` block and the #14 KV namespace commented. Do not create placeholder queues or a KV namespace in order to deploy.
- `PAYLOAD_SECRET` stays a Worker secret, not a var in `wrangler.jsonc`.
- Once #15 is deployed, the cron `*/5 * * * *` is active and can fire on deploy.
- `wrangler.jsonc` on `main` still has D1 `database_id` set to the placeholder `DATABASE_ID`.

## Open pull requests

| PR | Title | Base | Closes | State |
| --- | --- | --- | --- | --- |
| #15 | feat: background jobs, queue consumer, and job monitor | #11 branch | #5 in the body, not registered by GitHub | Draft |
| #14 | feat: centralized system parameters with typed values and isolate cache | #11 branch | #9 in the body, not registered by GitHub | Draft |
| #13 | feat: row-level security and organizational data scoping | #11 branch | #2 in the body, not registered by GitHub | Draft |
| #12 | feat: field-level audit trail for collection changes | `main` | #3 | Draft |
| #11 | Add dynamic RBAC and the permission matrix | `main` | #1 | Draft |

No pull request was open without an issue number in its body. Comments were not added. The token also cannot create issue comments (HTTP 403).

## Open issues

No milestones exist. The token cannot create milestones or labels (HTTP 403 on both APIs). The Milestone and Labels columns are the assignment to apply when a person with permission can create them. Nothing below was written onto the issues.

| Issue | Title | Proposed milestone | Proposed labels |
| --- | --- | --- | --- |
| #1 | Dynamic RBAC and permission matrix | M1 Foundation | `type:feature`, `area:admin`, `status:in-review`, `priority:p0` |
| #2 | Row-level security and organizational data scoping | M1 Foundation | `type:feature`, `area:collections`, `status:in-review`, `priority:p0` |
| #3 | Granular audit trail and column-level change logging | M1 Foundation | `type:feature`, `area:collections`, `status:in-review`, `priority:p0` |
| #4 | IP whitelisting and scheduled access windows | M3 Operator workflows | `type:feature`, `area:admin`, `status:ready`, `priority:p1` |
| #5 | Background job processing and queue monitoring | M2 Operations | `type:feature`, `area:platform`, `status:in-review`, `priority:p1` |
| #6 | Outbox notification system | M2 Operations | `type:feature`, `area:collections`, `status:ready`, `priority:p1` |
| #7 | State machine and approval workflow | M3 Operator workflows | `type:feature`, `area:collections`, `status:ready`, `priority:p2` |
| #8 | Advanced data grid | M3 Operator workflows | `type:feature`, `area:admin`, `status:ready`, `priority:p2` |
| #9 | System parameters and configuration | M2 Operations | `type:feature`, `area:collections`, `status:in-review`, `priority:p1` |
| #10 | Safe script runner | M3 Operator workflows | `type:feature`, `area:admin`, `status:ready`, `priority:p2` |
| #16 | chore: adopt agent and architecture standards | M1 Foundation | `type:chore`, `status:in-progress`, `priority:p1` |

#16 is the tracking issue for the standards pull request. The title is correct. The body is the single word `probe` because the same token can create an issue and cannot edit one (`PATCH /issues/16` returns 403). Tony can replace the body. The requirements are the pull request that says `Closes #16`.

`status:in-review` means an open draft pull request exists. `status:ready` means no pull request yet. Priority: #1–#3 are p0 because the later pull requests stack on them. #4, #5, #6, and #9 are p1. #7, #8, and #10 are p2.

### Labels and milestones that still need to be created

Do not delete the existing default labels (`bug`, `documentation`, `duplicate`, `enhancement`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`).

Labels to add:

- `type:feature`, `type:bug`, `type:chore`, `type:docs`
- `area:frontend`, `area:admin`, `area:collections`, `area:persistence`, `area:platform`, `area:tests` (one per current module in `docs/ARCHITECTURE.md`)
- `status:ready`, `status:in-progress`, `status:in-review`, `status:blocked`
- `priority:p0`, `priority:p1`, `priority:p2`

Milestones to add:

- **M1 Foundation.** RBAC (#1), row-level scope (#2), audit (#3), and these standards (#16).
- **M2 Operations.** Background jobs (#5), notification outbox (#6), system parameters (#9).
- **M3 Operator workflows.** Access windows (#4), state machine (#7), data grid (#8), script runner (#10).

## Backlog with no issue

Searched `src/`, `tests/`, and `README.md` for `TODO` and `FIXME`. None. The README has no roadmap beyond the template itself. Issues #1–#10 already cover the product backlog. No extra issue was filed. #16 is the standards adoption.

## Known blockers

- The five feature pull requests are drafts and stacked. Merging #13, #14, or #15 before #11 lands on `main` merges the RBAC branch with them.
- #12 must not follow #11 onto `main` until its interim audit read rule is replaced in that same change.
- `main` has no GitHub Actions workflow yet. The standards pull request adds a report-only architecture job. It does not deploy.
- D1 on `main` still uses the placeholder database id `DATABASE_ID`.
- A production deploy of the OpenNext bundle needs a Workers paid plan. See the deploy prerequisites. Agents do not upgrade the account.
- The build-fix pull request in the merge order has no number yet.
- Labels, milestones, and issue edits are blocked for the cloud-agent token (HTTP 403).

## This change

Pull request #17 (draft, `cursor/agent-standards-94c6`, closes #16) adds `AGENTS.md`, vendored ponytail and i-have-adhd skills, Cursor rules, `.cursor/mcp.json`, this file, `docs/ARCHITECTURE.md`, and `.github/workflows/architecture.yml`. It does not change product behavior.
