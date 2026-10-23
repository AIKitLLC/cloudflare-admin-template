# Cloudflare Service Admin Template

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/AIKitLLC/cloudflare-admin-template)

A production-ready, Cloudflare-native service admin template built with **Payload CMS v3**, **Next.js (App Router)**, **Cloudflare D1 (SQLite)**, and **Cloudflare R2** object storage.

Designed as an extensible starter kit for building custom back-office portals, internal tools, and administrative dashboards on the Cloudflare serverless edge.

---

## ⚡ Tech Stack

- **Framework:** [Payload CMS v3](https://payloadcms.com) (Code-first, type-safe headless CMS & admin engine)
- **Frontend / SSR:** [Next.js](https://nextjs.org) (App Router, React 19)
- **Runtime:** [Cloudflare Workers](https://workers.cloudflare.com) via [@opennextjs/cloudflare](https://opennext.js.org/cloudflare)
- **Database:** [Cloudflare D1](https://developers.cloudflare.com/d1/) (Serverless distributed SQLite with `@payloadcms/db-d1-sqlite`)
- **Storage:** [Cloudflare R2](https://developers.cloudflare.com/r2/) (S3-compatible asset storage via `@payloadcms/storage-r2`)
- **Testing:** [Vitest](https://vitest.dev) & [Playwright](https://playwright.dev)

> **Note on Workers plans:** Cloudflare limits Worker size to **64 MiB uncompressed on both the Free and Paid plans**, with no compressed size limit ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#worker-size)). A local build of this template produces about 15.7 MiB uncompressed (about 3.6 MiB gzip; measured 2026-10-17 06:18 CT at commit `b6c8198` with `wrangler deploy --dry-run`), so bundle size alone does not require Workers Paid. CPU time per request (10 ms on Free) and the 1 second startup limit have **not been measured** yet; check them with `wrangler` and Workers Logs before choosing a plan.

---

## 🚀 Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org/) `>= 22.14.0` (CI uses Node 22, see `.nvmrc`)
- [pnpm](https://pnpm.io/) `>= 9.x`
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### 2. Install Dependencies

```bash
git clone https://github.com/AIKitLLC/cloudflare-admin-template.git my-service-admin
cd my-service-admin
pnpm install
```

### 3. Local Development

Authenticate Wrangler with your Cloudflare account:

```bash
pnpm wrangler login
```

Copy the example environment file:

```bash
cp .env.example .env
```

Generate a random secret for `PAYLOAD_SECRET`:

```bash
openssl rand -hex 32
```

Start the local development server (Wrangler will emulate D1 and R2 locally):

```bash
pnpm dev
```

Open [http://localhost:3000/admin](http://localhost:3000/admin) and create the first administrator on the setup screen, or from the command line:

```bash
FIRST_ADMIN_PASSWORD='<password>' pnpm admin:create --email admin@example.com --confirm
```

See [First admin and admin access](#first-admin-and-admin-access).

---

## 🛠️ Project Structure

```text
├── src/
│   ├── app/                 # Next.js App Router (Admin & API endpoints)
│   ├── access/              # RBAC decision pipeline and collection/field helpers
│   ├── audit/               # Opt-in field-level audit trail (see src/audit/README.md)
│   ├── scope/               # Organizational row scope, hierarchy, and assignment guards
│   ├── collections/         # Payload Collection definitions
│   │   ├── Users.ts         # User authentication collection
│   │   └── Media.ts         # Asset upload collection (R2)
│   ├── components/rbac/     # Permission matrix admin view
│   ├── rbac/                # Roles, permissions, seeding, and matrix API
│   ├── migrations/          # D1 database migrations
│   ├── payload.config.ts    # Main Payload CMS configuration & bindings
│   └── payload-types.ts     # Auto-generated TypeScript types
├── tests/                   # Integration and E2E test suites
├── wrangler.jsonc           # Cloudflare Workers, D1 & R2 configuration
├── open-next.config.ts      # OpenNext build adapter configuration
└── package.json
```

---

## 📦 Adding Custom Service Collections

Wrap collections with `withRbac` so they join the permission matrix. Startup sync creates `create`, `read`, `update`, `delete`, and `export` permissions plus field read/write permissions for every data field.

```typescript
import type { CollectionConfig } from 'payload'
import { withRbac } from '../access/with-rbac'

export const Customers: CollectionConfig = withRbac({
  slug: 'customers',
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'email', type: 'email', required: true, unique: true },
    { name: 'status', type: 'select', options: ['active', 'suspended'], defaultValue: 'active' },
  ],
})
```

Add the collection to `src/payload.config.ts`:

```typescript
import { Customers } from './collections/Customers'

export default buildConfig({
  collections: [Users, Media, Roles, Permissions, RolePermissions, Customers],
  // ...
})
```

Generate updated TypeScript types:

```bash
pnpm generate:types
```

Restart the app once so the permission catalog picks up the new collection. Grant the new keys from **Permission Matrix** in the admin nav.

## 🔐 Role-Based Access Control

Roles, permissions, and role-permission grants live in D1.

- **Super Admin** (`grantsFullAccess`) bypasses the matrix. The first user on an empty install receives this role. On an upgrade where users already exist and none has a role, only the earliest user (lowest `createdAt`, then lowest id) receives it, and that user's id and email are logged. The promotion runs once.
- Only a full-access user can turn on `grantsFullAccess` or assign or remove a full-access role. Anyone else can grant only permissions they already hold, and can assign only roles whose grants are a subset of their own. They can update, delete, or unlock another user only when that user's permissions are a subset of theirs, including password and email changes. The last full-access assignment cannot be removed.
- Other roles start with no grants. Assign actions per collection and read/write per field in `/admin/permission-matrix`. Plugin collections and globals are covered by the same rules. A global's keys are `global:{slug}:read` and `global:{slug}:update`.
- `GET /api/{collection}/export` returns CSV. It requires the `export` action and still applies read and field permissions.
- Media keeps anonymous read for public file URLs. Signed-in users still need `media:read`.

Run the committed D1 migration before production deploy:

```bash
pnpm payload migrate
```

`src/migrations/20261010_080938_rbac_permission_matrix.ts` creates `roles`, `permissions`, `role_permissions`, and the user-role join. It is registered in `src/migrations/index.ts` and passed to the D1 adapter as `prodMigrations`, so a production Worker also applies it on connect. See [docs/rbac.md](docs/rbac.md) for the access pipeline and the extension points used by later features.

## Organizational row scope

Users can be assigned organizations, branches, and data classes. Organizations and branches form trees. A data class parent is a group: assignment includes every nested class. Non-full-access reads, updates, deletes, and `GET /api/{collection}/export` on a scoped collection are limited to that effective scope. Creating or retagging a row outside it is refused.

A limited user can assign only scope values they already hold, including inherited ones, and cannot edit their own assignments or see user accounts outside that scope. Adding scope to someone else also requires that their permission keys are already within the actor's. Granting a permission is refused when a holder of that role can see rows outside the granter's scope. See [docs/row-scope.md](docs/row-scope.md).

Opt in with `rowScope` on `withRbac`, and wrap the result directly in `withRowScope` from `src/scope`. `withRowScope` attaches the scope hooks, and `payload.config.ts` refuses to boot if a row-scoped collection is not wrapped:

```typescript
export const Customers = withRowScope(
  withRbac(
    {
      slug: 'customers',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'organization', type: 'relationship', relationTo: 'organizations', required: true },
        { name: 'branch', type: 'relationship', relationTo: 'branches', required: true },
        { name: 'dataClass', type: 'relationship', relationTo: 'data-classes', required: true },
      ],
    },
    {
      rowScope: {
        organizationField: 'organization',
        branchField: 'branch',
        dataClassField: 'dataClass',
      },
    },
  ),
)
```

## Background jobs

Long-running work is a row in `jobs`, not an HTTP request. Only names registered with `defineJob` can run. The admin **Job Monitor** (`/admin/job-monitor`) lists jobs, shows redacted payloads and logs, and can trigger or retry when the role has `jobs:trigger` or `jobs:retry`. Viewing requires `jobs:read`. Those keys are denied until granted.

The Worker entry is `custom-worker.ts`. Its `queue` and `scheduled` handlers forward to the OpenNext `fetch` handler on an internal route, so Payload is bundled once. `pnpm build:worker` runs `next build --webpack`, then inlines `preview-props.json` and fills a missing `x-forwarded-host` from the request URL so `jobs.internal` survives OpenNext. Webpack does not emit Turbopack's hashed `drizzle-kit` require, so there is no drizzle-kit esbuild stub. Migrations still use the real `drizzle-kit` through `payload migrate`.

Deploying this branch enables a cron of `*/5 * * * *`. It is active in `wrangler.jsonc` and starts firing as soon as the Worker is deployed, every five minutes, with or without a queue. Each run reaps expired leases and executes a bounded set of due jobs inside that invocation. Set `JOBS_INTERNAL_SECRET` with `wrangler secret put JOBS_INTERNAL_SECRET` (at least 32 characters). Do not put it in `wrangler.jsonc` vars.

Cloudflare Queues are optional. The `queues` block in `wrangler.jsonc` is commented out, the same way an optional binding stays commented until the resource exists. Wrangler rejects a deploy that names a queue which does not exist, so leave that block commented until the queues have been created and the placeholder names have been replaced. When `JOB_QUEUE` is absent, jobs stay `PENDING` until the cron runs them. Local `pnpm dev` still runs due jobs in-process. Vitest does not. See [docs/jobs.md](docs/jobs.md).

## 🚢 Deployment

### 1. Create Cloudflare Resources

Create your D1 Database:

```bash
pnpm wrangler d1 create <YOUR_DATABASE_NAME>
```

Create your R2 Bucket:

```bash
pnpm wrangler r2 bucket create <YOUR_BUCKET_NAME>
```

Update `wrangler.jsonc` with your D1 `database_id` and R2 bucket name.

Set the public origin before the Worker serves traffic. `PAYLOAD_PUBLIC_SERVER_URL` is required in production. Admin login cookies, CSRF, and media URLs all use it. `PAYLOAD_ALLOWED_ORIGINS` is an optional comma-separated list of extra browser origins. Put both in the Worker environment, for example the commented `vars` block in `wrangler.jsonc`. Keep `PAYLOAD_SECRET` as a secret, not a var.

### 2. Apply database migrations

The template includes the initial migration, the audit-log tables, Payload's KV table, and the RBAC tables. Apply them to the local D1 database:

```bash
pnpm payload migrate
```

Run `pnpm payload migrate:create` only after a schema change, when you need a new migration file. It does not update D1.

`pnpm run deploy` applies those migrations to the remote D1 database (`payload migrate` with `NODE_ENV=production`) and then runs `PRAGMA optimize`.

### 3. Build the Worker and deploy

Build the OpenNext bundle. `pnpm build` only runs Next.js. `pnpm build:worker` runs that build through OpenNext and applies the preview-props patch described in [docs/worker-build.md](docs/worker-build.md).

```bash
pnpm build:worker
```

Check the bundle without uploading anything:

```bash
pnpm exec wrangler deploy --dry-run
```

Serve that bundle on your machine with local D1 and R2:

```bash
pnpm exec wrangler dev --local
```

Open [http://localhost:8787/admin](http://localhost:8787/admin).

Set `PAYLOAD_SECRET` on the Worker before the first real deploy (`wrangler secret put PAYLOAD_SECRET`). Then deploy migrations and the app:

```bash
pnpm run deploy
```

Then open `/admin` right away and create the first admin, or set up the required Cloudflare Access application for `/admin` and `/api/users/*` first (recommended) and create the admin through Access. See [First admin and admin access](#first-admin-and-admin-access).

For plan limits, see the note on Workers plans at the top of this file.

---

## First admin and admin access

Full steps are in [docs/admin-access.md](docs/admin-access.md).

1. **Create the first admin right after deploy, or enable Cloudflare Access first.** On a new install, `/admin` shows the "create first user" screen; the first account created there gets the Super Admin role and you are signed in. Until then, whoever completes that screen first becomes the admin, so either set up Access before the deploy is reachable (recommended) or create the admin immediately. `pnpm admin:create --email <email> --confirm` (password from `FIRST_ADMIN_PASSWORD`) does the same from the command line. For remote D1, run it with `NODE_ENV=production PAYLOAD_SECRET=ignore` after `pnpm run deploy:database`.
2. **Setup runs once.** Concurrent setup requests or CLI runs create exactly one admin. After the first admin exists, the setup screen is closed for good, even if all users are later deleted; `pnpm admin:create` can recover an empty `users` table. From then on only a signed-in user with `users:create` can add users.
3. **Cloudflare Access is required in production** in front of `/admin` and `/api/users/*` (including `/api/users/login` and `/api/users/first-register`). See [the Access steps](docs/admin-access.md#cloudflare-access-is-required-in-production).

Admin session cookies are `Secure` in production (`SameSite=Lax`). Sign-in is limited per account (Payload: 5 failures, 10-minute lock) and per client IP: sign-in, forgot-password, reset-password, refresh-token (requests without a valid session), and first-run setup each have their own 15-minute limit, then 429. Add the Cloudflare WAF rate limiting rule described in [docs/admin-access.md](docs/admin-access.md#cloudflare-waf-rate-limiting-rule) as well.

## 🧪 Testing

Run every CI check locally (install, typecheck, lint, unit, integration, Next.js build, Worker bundle). No secrets or Cloudflare account needed:

```bash
pnpm ci:local                      # or: scripts/ci-local.sh
scripts/ci-local.sh --maxWorkers 2 # cap test parallelism on small machines
```

Individual steps:

```bash
# Firebase client authentication and route/ownership/quota identity tests
pnpm test:unit

# Actual local Cloudflare runtime using synthetic signed tokens (no external calls)
pnpm test:firebase:runtime

# Run isolated Payload D1/R2 and native route integration tests
pnpm test:int

# Build the application, exercise its local HTTP APIs, and package the Worker
pnpm build
pnpm test:api
pnpm test:client-security:browser
pnpm build:worker

# Run end-to-end Playwright tests
pnpm test:e2e


# Rebuild the Worker, dry-run the bundle, and serve /admin locally
pnpm test:worker
```

---

## Firebase Native Clients

The protected `GET /api/client/v1/me` example requires both a Firebase App Check token
and a Firebase Anonymous Authentication ID token. It derives the client UID from the
verified ID token and keeps Firebase clients separate from Payload administrator
sessions. Owners manage public Firebase trust and persistent UID/IP/global quotas
at `/admin/client-security`. Defaults remain disabled with zero quotas; activation
requires the real project ID/number, allowed App IDs, and reviewed limits. Existing
admins are not automatically promoted to owner. Audited revisions and rollback
preserve active usage and reject stale saves.

See [Firebase client authentication](docs/firebase-client-auth.md) for setup, Play
Integrity requirements, the reusable route adapter, ownership/quota examples, and
verification limits.

---

## 📄 License

MIT © [AI Kit LLC](https://github.com/AIKitLLC)

## Audit trail

`Users` and `Media` record an append-only, field-level audit row on create, update, and delete. Opt another collection in with `withAuditTrail` from `src/audit`. Passwords, tokens, hashes, salts, sessions, and similar secrets are stored as `[REDACTED]`. A failed audit write is counted, logged, and does not fail the user's change.

`untrustedClientIp` is personal data visible to anyone who can read the trail. Reads use the `audit-logs:read` grant. Full access still passes. The collection is not wrapped in `withRbac`, so create, update, delete, and export are not matrix cells. The D1 migration `src/migrations/20261010_080422_audit_logs.ts` creates only `audit_logs` and `audit_logs_changes`. It does not create `payload_kv`. See [src/audit/README.md](src/audit/README.md).
