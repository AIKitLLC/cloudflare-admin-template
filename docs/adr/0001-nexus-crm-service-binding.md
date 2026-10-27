# ADR 0001: Nexus CRM installs as its own Worker behind a service binding

Status: proposed (2026-10-26). Needs Tony's approval before the build phases of #44 start.

## Context

#44 asks for nexus-crm as a vertical plugin of this template and lists three data-model options:

- (a) generate Payload collections from Nexus object definitions,
- (b) one universal-record Payload collection with JSON fields,
- (c) keep the Nexus D1 schema and expose it through an adapter.

Nexus today is a separate Hono Worker: 41 D1 tables, a metadata-driven universal record model, a Queue consumer, an R2 bucket, an MCP endpoint, and a React SPA. Its own login is one owner password.

Constraints from this repo: Payload and OpenNext bundle everything at build time, so a Worker cannot load plugin code from a file at runtime. The template Worker is about 15.7 MiB uncompressed already. Agents may not deploy or touch a Cloudflare account.

## Decision

Option (c), with the adapter being a Cloudflare service binding instead of Payload collections:

1. Nexus stays its own Worker with its own D1, R2 and Queue. It is deployed separately and gets no public route of its own when installed this way (`workers_dev: false`, no `routes`).
2. The template gets one optional service binding, `NEXUS`, in `wrangler.jsonc`. Installing the CRM is: deploy the Nexus Worker, add the binding, set one shared secret on both Workers. Removing the binding uninstalls it; Nexus data stays in its own D1.
3. The template answers `/nexus/*` and `/api/nexus/*`. For each request it:
   - authenticates the caller with Payload (`payload.auth`), the same session the admin uses;
   - checks the template permission keys `nexus:access` (read and work in the CRM) and `nexus:admin` (Nexus admin screens, MCP tokens), added through `registerCatalogContributor`, so the permission matrix and roles govern the CRM like every other feature;
   - forwards the request to `env.NEXUS.fetch()` with the path prefix removed, the caller's cookies and `Authorization` header stripped, and one header, `x-nexus-identity`, carrying `{userId, email, role, workspace, exp}` signed with HMAC-SHA256 over the shared secret `NEXUS_BRIDGE_SECRET`, valid for 60 seconds.
4. Nexus accepts `x-nexus-identity` as a session only when the signature and expiry check out. Role mapping: `nexus:admin` becomes Nexus `admin`, `nexus:access` alone becomes `member`. Template Super Admins become Nexus `owner`. The workspace is the installation's `DEFAULT_WORKSPACE_SLUG` for now; mapping template organizations to Nexus workspaces is a later step.
5. The Nexus SPA is served under `/nexus/` (Vite `base`, router `basename`, API base). It stays the CRM UI. Rewriting it as Payload admin views (the long-term idea in #44) is not part of this decision.

## Why not (a) or (b)

- (a) turns every Object Studio change into a Payload schema change and a migration, which Nexus users make at runtime. It also puts Nexus's 41 tables and its Queue consumer into the template bundle.
- (b) is the cheapest port but loses filtering, field-level RBAC and the operational tables (inbox, journeys, outbox) that need real state machines.
- Both mean porting about 4,000 lines of Nexus core and rewriting its tests. (c) reuses Nexus as it is and adds one route on each side.

## What this costs

- Two Workers to deploy and keep in step. The bridge header is the contract between them; it is versioned (`v1.` prefix) so either side can refuse an unknown version.
- A service binding call per CRM request (same colo, no public hop).
- Nexus RBAC stays coarse (owner/admin/member). Fine-grained template grants do not reach inside Nexus.
- The template's audit trail does not see Nexus writes. Nexus keeps its own audit table.

## Security

- The secret never reaches the browser. The browser only has the template session cookie, which the proxy strips before forwarding.
- Nexus without a public route can only be reached through the binding. The HMAC check still runs, so a Nexus Worker that is reachable by mistake does not trust a forged header.
- The header expires after 60 seconds, so a logged header cannot be replayed later.
- `/api/nexus/*` refuses requests from other origins the same way the template's other write routes do.

## Prototype (this pull request)

Contacts and deals end to end through the binding: list and create, refused without `nexus:access`, read-only Nexus role refused on create. Covered by an E2E project that starts both Workers locally (`wrangler dev -c wrangler.jsonc -c <nexus>/wrangler.e2e.jsonc`) with empty local D1 databases. It never touches `nexus-crm-prod`.

## Follow-ups after approval

1. Organizations to workspaces mapping.
2. Nexus SPA under `/nexus/` with the template's navigation link.
3. MCP through `/api/nexus/mcp` with template-issued tokens.
4. CI: the E2E project needs the Nexus repository (private), so CI needs a read token or a published Nexus build.
5. Cutover runbook for `nexus-crm-prod`.
