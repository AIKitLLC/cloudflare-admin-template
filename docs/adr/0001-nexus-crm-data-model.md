# ADR 0001: How nexus-crm's data model lands in Payload

Status: **Proposed.** Awaiting Tony's approval. Nothing is built before that. Tracking issue: #44 (phase 1, spike).

`docs/adr/` did not exist in this repo, so this file starts it. The numbering and the name are this spike's choice.

## Context

nexus-crm (`AIKitLLC/nexus-crm`, Apache-2.0) is a Vite SPA plus a Hono Worker on D1 and Queues. Its data is a metadata-driven universal model: `object_definitions`, `field_definitions`, `records` (indexed columns plus `data_json`), `record_relationships`, and 43 D1 tables in all (the README says 41/42). Its 37 MCP tools (14 read, 23 write; #44 says 36) sit on application services that enforce `dryRun`, `idempotencyKey` and `expectedVersion`.

This template is Payload 3.91 on Next.js 16 on Workers, with collections written in code. #44 asks for nexus-crm as a vertical plugin (`createNexusCrmPlugin(options) -> (config) => Config`) that uses only the public module entries from #45 (merged as #51).

The question: how does a runtime-defined object model become Payload collections?

## Decisions already taken with the owner during the spike

| # | Question | Decision |
| --- | --- | --- |
| 1 | Tenancy | One workspace per install. `workspace_id` is a constant column (or dropped). No workspace row-scope. |
| 2 | Object Studio | Required at runtime: end users create objects and fields without a deploy. |
| 3 | Auth | Drop nexus's owner password and HMAC session. Use Payload `users`. |
| 4 | Roles (A1) | The five nexus roles (`owner/admin/manager/member/viewer`) become five seeded RBAC `roles`. `nexus-owner` is a normal role, **not** `grantsFullAccess`. |
| 5 | MCP tokens (B1) | Keep nexus's own hashed, revocable `nxmcp_` token table. A token acts as a Payload user, so RBAC still applies. |
| 6 | Events | Keep `domain_events` and `outbox` in D1. Replace the `EVENTS` Queue with one `defineJob` (`nexus.dispatch-outbox`) driven by the template cron. Accept up to ~5 minutes of automation latency. |
| 7 | Packaging (P1) | Plugin source lives in the nexus-crm repo at `packages/nexus-crm-plugin/`. The template is a `peerDependency`. |
| 8 | MCP (M1) | One `POST /api/nexus/mcp` endpoint keeps the MCP protocol and the 37 tools. Only the URL changes for agents. |
| 9 | Cutover (C1) | A short read-only freeze on nexus, then copy data into the new install. `nexus-crm-prod` stays untouched for rollback. |

## Options

- **(a) Codegen.** One real Payload collection per object definition, built when the plugin initialises.
- **(b) Universal record.** One `nexus_records` collection, data in a JSON field.
- **(c) Adapter.** Keep the nexus D1 schema and expose it through endpoints.
- **(d) Hybrid (proposed).** Standard objects (contacts, organizations, deals, and later the other standard ones) are real collections built with (a). Custom objects created at runtime are rows in `nexus_object_definitions` and their records live in `nexus_records` (b).

## What was measured

Prototype: `spike/nexus-crm/` (throwaway, 5 files, ~380 lines) and `tests/int/nexus-spike.int.spec.ts` (7 tests, all pass locally on Windows, run on their own). It boots the real `payload.config.ts` with the plugin loaded.

| Measurement | Result |
| --- | --- |
| Boot with nexus collections | `ensure-rbac-coverage` passes in `onInit`. All four nexus collections are covered. |
| (a) contacts and deals as collections | Create, list, relationship (deal to contact), and a viewer who can read but not create all work through the Local API with `overrideAccess: false`. Field-level `readField` strips `email` for a role without that key. |
| (a) permission rows | 17 per collection (5 actions plus read and write for each of 6 fields). The permission matrix shows every field. |
| (b) `nexus_records` | A custom object (`vehicle`) defined at runtime and a record created with **no migration and no deploy**. Required and select rules had to be rewritten by hand in a `beforeValidate` hook. |
| (b) field-level RBAC | The whole `data` blob is one permissioned field (`nexus_records:readField:data`). There is no key for `data.email`. |
| (b) filtering | Payload accepted a `where` on `data.lifecycle` and returned the row. Whether the admin list filter UI offers JSON sub-paths was **not** checked. |
| (c) adapter | List and create work behind a hand-written RBAC check, but there is **no collection**: no admin list or create view, and the catalog has only the two keys registered by hand. |
| (a) migration cost, initial | `payload migrate:create` for the four nexus collections: 144-line migration plus a 96.5 KB full-schema JSON snapshot (5 `CREATE TABLE`). |
| (a) migration cost, one new field | One field added to contact: a 9-line migration (`ALTER TABLE ... ADD`) plus a **new 96.7 KB snapshot**. It needs a code change, a commit, a deploy and `payload migrate`. End users cannot do it. |
| Template module boundary test | `tests/unit/module-boundaries.test.ts` passes 9/9 with the spike present. eslint is clean on the spike files. |
| Plugin adds migrations | Wrapping `config.db.init` and appending to `adapter.prodMigrations` works (tested). Production applies `prodMigrations` on connect. `payload migrate` reads files from `src/migrations` only, so the CLI path does not see them. |

Not verified: the admin UI in a browser (needs a sign-in and a local `.env`; the spike did not create one), `pnpm build:worker`, anything on a Cloudflare account, and the other integration files (11 of 22 fail on `main` on this machine). The new test file passes by itself.

## Comparison

| | (a) Codegen | (b) Universal JSON | (c) Adapter | (d) Hybrid |
| --- | --- | --- | --- | --- |
| Admin UX | Best: native list, filters, forms, relationships | Weak: generic table, JSON editor for attributes | None: needs custom views for everything | Best for standard objects, generic for custom ones |
| RBAC and field-level | Per field, in the matrix | Per collection; one key for all of `data` | Hand-registered keys only | Per field for standard, per collection for custom |
| Runtime Object Studio | **Fails the requirement.** Every change is a migration and a deploy | Works, no migration | Works | Works for custom objects |
| Migration cost per change | One migration file plus a ~97 KB snapshot, plus deploy | None | None in Payload, but the table sits outside Payload's schema | None for custom, one migration for a new standard field |
| Maintenance | Codegen is small; the schema belongs to Payload | Validation and search text are re-implemented | Highest: nexus schema, adapter, RBAC and UI all kept in sync by hand | Two code paths, both small |
| Cutover risk | Data copy is column to column | Closest to nexus `records` (`data_json` maps 1:1) | Lowest data risk, highest integration risk | Standard records need column mapping, custom ones copy as is |
| Dev drizzle push | Normal | Normal | Unmanaged table next to Payload's schema; the drizzle dev push may try to drop it (not tested) | Normal |

## Decision (proposed)

Adopt **(d) the hybrid**.

- Standard objects use (a). Their definitions are plain data in the plugin and are turned into collections at plugin init, so there is no code generation step and nothing to commit besides one migration per released change.
- Custom objects use (b), described by rows in `nexus_object_definitions`. This is the only option that meets the runtime requirement without a deploy.
- Promoting a custom object to a real collection later is a normal release (a definition moves from data to the plugin, plus one migration and a data copy).
- (c) is rejected. It keeps the nexus schema alive next to Payload and gives up the admin UX that is the reason for the port.
- (a) alone is rejected because of the runtime requirement. (b) alone is rejected because contacts and deals would lose field-level RBAC and native filtering.

## Answers to the questions #44 asked

**Tenancy.** One workspace per install, so `workspace_id` is a constant. Neither `registerRowScopeContributor` nor `withRowScope` is needed for the workspace boundary. If a deployment needs internal boundaries (for example per branch), it can wrap a collection with `withAuditTrail(withRowScope(withRbac(...)))`; `assertRowScopeHooks` runs on the final collection list in `onInit` and already covers plugin collections. The spike did not exercise this path.

**Auth and roles.** The plugin does not carry its own login. Payload `users` replace `memberships`. The `users.role` field (`owner/admin/editor`) belongs to client-security and is unrelated to RBAC roles: its guard (`src/auth/client-security-owner.ts`) protects client-security owner operations, and the spike's test users ran into it when created with a non-default value. Nexus roles map to seeded RBAC roles (`nexus-owner`, `nexus-admin`, `nexus-manager`, `nexus-member`, `nexus-viewer`), seeded in `onInit` after the template's catalog sync. A user needs a Payload account to hold a nexus role. `memberships.permissions_json` overrides become extra `role-permissions` rows on a custom role. MCP tokens (B1) stay in their own table and act as a Payload user.

**Events and queue.** The template's `custom-worker.ts` has one `queue` handler that forwards to the jobs route, and the `JOB_QUEUE` block in `wrangler.jsonc` is commented out. A plugin cannot add its own Queue consumer without patching those files. So: keep `domain_events` and `outbox` in D1 as the source of truth, and run one `defineJob` that dispatches due outbox rows in small batches. The template cron (`*/5 * * * *`) runs at most two jobs per invocation within a 40-call budget, so a burst of events drains over several runs. Template issue #6 is a notification outbox (email and SMS) that has no code yet. It is a different thing from the nexus event outbox and is not a replacement for it.

**Object Studio.** Under (d), a custom object or field is a row, not a migration, so the cost per change is zero migrations and zero deploys. Under (a) it would be one migration plus a ~97 KB snapshot plus a deploy per change. Field-level permissions for custom fields cannot come from the collection catalog, because the catalog is built from collection config. The plugin should register them with `registerCatalogContributor` and enforce them in a read hook. The spike did not build that.

**36 (really 37) MCP tools.** `POST /api/nexus/mcp`, a Payload custom endpoint that keeps the Streamable HTTP protocol and the same application services. Each call authenticates the `nxmcp_` token, resolves the Payload user it acts as, and runs through RBAC. The `dryRun`, `idempotencyKey` and `expectedVersion` contract is unchanged. The spike did not build this.

**Packaging and licence.**
- Code: `packages/nexus-crm-plugin/` in `AIKitLLC/nexus-crm` (P1). The SPA and the plugin share the domain and application code until cutover. This needs nexus-crm to become a workspace; that change is out of scope for the spike.
- Registry: `@aikit/nexus-crm-plugin` on the public npm registry is free. Publishing is out of scope until the ADR is approved. GitHub Packages is the alternative if the scope must stay private.
- Licence: the package stays Apache-2.0. The template (MIT) is a `peerDependency` and nothing of it is bundled, so the only extra is a `NOTICE` file in the package that names the Apache-2.0 copyright holder and says it runs on an MIT-licensed host. nexus-crm has no `NOTICE` today, so there is no upstream NOTICE text to propagate. If the plugin ever copies template source (for example test helpers), keep that file's MIT notice. nexus-crm's `third_party/` must not ship in the package. This is not legal advice; confirm before publishing.

**Cutover (outline, C1).**
1. Install the plugin in a fresh template install and run its migrations.
2. Write an import script that reads an export of `nexus-crm-prod` (never writes to it) and maps ids. Standard objects map column to column; custom objects copy `data_json` into `nexus_records.data`. Reconcile record and relationship counts.
3. Rehearse on a copy until counts and a sample of MCP calls match.
4. On the day: put nexus into read-only, run a final import, verify, then move users and MCP agents to the new URL.
5. Keep `nexus-crm-prod` read-only for a soak period. Rollback is pointing back at it. Retiring it is a separate decision.

## Proposals back to the template

The plugin may not patch template source, so these are gaps to close in the template before a real build.

1. **Distribution of the public entries.** The template is a repo you clone, not a package. A plugin published to npm cannot import `src/access` or `src/rbac`. Pick one: publish the entries as a package (for example `@aikit/admin-kit`), or have `createNexusCrmPlugin({ kit })` receive `withRbac`, `withAuditTrail`, `defineJob` and `registerCatalogContributor` from the host. This is the biggest gap and V1 in #44 depends on it.
2. **Plugin migrations.** `payload migrate` ignores `prodMigrations`, and the plugin cannot add files to `src/migrations`. Either the template exposes a way to register extra migrations (the spike's `db.init` wrapper shows one that works for production), or it documents that the host spreads the plugin's migrations into `prodMigrations`.
3. **Queue consumers and bindings.** A hook to register extra Queue consumers and to declare plugin bindings, or a stated rule that plugins use `defineJob` only.
4. **Role seeding.** `src/rbac` has no public "ensure role with these permission keys" call. The spike wrote it against the `roles` and `role-permissions` collections.
5. **Cron budget.** Two jobs per five minutes caps the outbox dispatcher. If latency matters, this needs a different trigger.

## Consequences

- The admin gets native lists, forms and field-level permissions for the objects people use most, and still supports runtime custom objects.
- Two storage shapes exist (collections and `nexus_records`). Reports, segments and the MCP tools must read both. A small reader that returns one shape for either source is needed.
- Validation for custom objects is hand-written (the spike's `validateAgainst` hook is the pattern).
- Standard-object changes cost a migration and a ~97 KB snapshot each; batch them into releases.
- Automation latency rises from seconds to up to ~5 minutes until the template gets a queue hook.
- The plugin cannot ship to npm until template gap 1 is settled.

## Open questions for Tony

1. Is up to ~5 minutes of automation latency acceptable, or should the template get a queue-consumer hook first?
2. Which gap in the section above should block the build phase? The spike suggests gap 1 (distribution of the entries).
3. Should `nexus-owner` ever be allowed to manage Payload users and roles, or stay limited to nexus data (A1 says limited)?
4. Public npm or GitHub Packages for `@aikit/nexus-crm-plugin`?
5. How long is the read-only freeze allowed to be, and who owns the cutover rehearsal?

## How to run the prototype

Local only. No Cloudflare account access and no secrets are involved; the test boots Payload on an isolated local D1.

```bash
pnpm install
pnpm exec tsc --noEmit
pnpm exec vitest run --config ./vitest.config.mts tests/int/nexus-spike.int.spec.ts
```

To try it in the admin, create your own `.env` from `.env.example`, run `pnpm dev`, create the first admin, and open the **Nexus CRM** group. The roles `nexus-owner`, `nexus-admin`, `nexus-manager`, `nexus-member` and `nexus-viewer` appear in `/admin/permission-matrix`. The spike wires itself with one import and one `plugins` entry in `src/payload.config.ts`, marked `SPIKE #44`. That edit is throwaway; the real plugin would not touch the config beyond adding itself to `plugins`.
