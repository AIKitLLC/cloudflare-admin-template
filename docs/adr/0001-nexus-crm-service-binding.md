# ADR 0001: Nexus CRM installs as its own Worker behind a service binding

Status: accepted (2026-10-26). Build phases 1 to 3 below are implemented; 4 and 5 are open.

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
4. Nexus accepts `x-nexus-identity` as a session only when the signature and expiry check out. Role mapping: `nexus:admin` becomes Nexus `admin`, `nexus:access` alone becomes `member`. Template Super Admins become Nexus `owner`. A template user whose email already exists in Nexus (the owner, on a cutover) is matched to that Nexus user by email, and an email changed in the template follows to Nexus. The workspace is the installation's `DEFAULT_WORKSPACE_SLUG` for now; mapping template organizations to Nexus workspaces is a later step.
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

## Build phases

### 1. Organizations as workspaces (done)

- One Nexus workspace per template organization, at any level. The identity header carries `workspace: {key, name}`, where key is `org_<id>_<createdAtMs>`. The creation time keeps an organization created later under a reused id (SQLite reuses the id of a deleted row) from inheriting an older workspace. Nexus upserts the workspace by id and the name follows renames.
- A user may open the organizations they were assigned plus their descendants (`grantableOrganizationIds`). A branch assignment alone does not open its organization. A user with no organization or branch assignment gets the installation's default workspace. Full access may open every organization and the default.
- The active workspace is the `nexus_org` cookie (set by the in-app switcher) or the `x-nexus-org` header, checked against that list; otherwise it is the first allowed one. `GET /api/nexus/workspaces` lists the choices.
- No roll-up: a parent organization's workspace does not show its children's records.

### 2. The Nexus app under `/nexus` (done)

- Nexus builds the SPA with `npm run build:embedded` (`--base /nexus/`, `VITE_NEXUS_EMBEDDED=1`). In that mode `/api/*` calls go to `/api/nexus/*`, the router basename is `/nexus`, sign-in and sign-out go to the admin's, and the switcher appears.
- `/nexus/*` (`src/app/nexus/[[...path]]/route.ts`) needs a template session and a Nexus role. Without a session it redirects to `/admin/login?redirect=…`. It serves the Nexus asset store through the binding with Nexus's CSP applied, and with Set-Cookie and HSTS removed. `/api/nexus/auth/me` is forwarded read-only.
- The admin sidebar shows a "Nexus CRM" link while the binding exists, for users with a Nexus role.

### 3. MCP at `/api/nexus/mcp` (done)

- Clients keep Nexus tokens (`Authorization: Bearer nxmcp_…`, minted at `/api/nexus/v1/mcp/tokens` with `nexus:admin`). For each call:
  1. The template asks Nexus over the binding who owns the token, at `POST /api/bridge/mcp-token`, which is HMAC-gated over the token hash.
  2. It checks that user's current grants (Nexus `admin` or `owner`) and that the token's workspace is still in their scope.
  3. It forwards the call with a signed identity.
- When `NEXUS_BRIDGE_SECRET` is set, Nexus refuses every MCP token without a matching identity and uses the lower of the token's role and the identity's. Removing a user's grants in the template therefore stops their tokens on the next call, even if they never open the CRM again, and a token sent straight to the Nexus Worker is refused.
- For a bridged install, also deploy Nexus with `workers_dev: false` and no routes.

### Local E2E note

`wrangler dev -c template -c nexus` in one process cannot serve the auxiliary Worker's assets when the primary also has assets (500, wrangler 4.116). The harness therefore runs Nexus as its own `wrangler dev` and reaches it through the local dev registry. Deployed Workers are not affected.

## Still open

4. CI: the E2E project needs the Nexus repository (private), so CI needs a read token or a published Nexus build.
5. Cutover runbook for `nexus-crm-prod`.
