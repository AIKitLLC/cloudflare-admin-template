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

> **Workers Paid.** A dry run of this Worker is about **15.2 MiB** uncompressed and **3.5 MiB** gzip. Gzip is over 3 MiB, so deploy on the **Workers Paid** plan. Details are in [docs/worker-build.md](docs/worker-build.md).

---

## 🚀 Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org/) `>= 24.15.0`
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

Open [http://localhost:3000/admin](http://localhost:3000/admin) to access the admin panel and create your initial administrator account.

---

## 🛠️ Project Structure

```text
├── src/
│   ├── app/                 # Next.js App Router (Admin & API endpoints)
│   ├── access/              # RBAC decision pipeline and collection/field helpers
│   ├── audit/               # Opt-in field-level audit trail (see src/audit/README.md)
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

---

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

The dry-run bundle on the build-fix branch is about 15.2 MiB uncompressed and 3.5 MiB gzip. Gzip is over 3 MiB. Use the Workers Paid plan. The current platform limit is 64 MiB uncompressed on every plan. The Free plan's 10 ms CPU limit is too small to render Payload.

---

## 🧪 Testing

```bash
# Run unit & integration tests
pnpm test:int

# Run end-to-end Playwright tests
pnpm test:e2e

# Compile the Next.js app (Payload 3.82 has no `payload build` command)
pnpm build

# Rebuild the Worker, dry-run the bundle, and serve /admin locally
pnpm test:worker
```

---

## 📄 License

MIT © [AIKit LLC](https://github.com/AIKitLLC)

## Audit trail

`Users` and `Media` record an append-only, field-level audit row on create, update, and delete. Opt another collection in with `withAuditTrail` from `src/audit`. Passwords, tokens, hashes, salts, sessions, and similar secrets are stored as `[REDACTED]`. A failed audit write is counted, logged, and does not fail the user's change.

`untrustedClientIp` is personal data visible to anyone who can read the trail. Reads use the `audit-logs:read` grant. Full access still passes. The collection is not wrapped in `withRbac`, so create, update, delete, and export are not matrix cells. The D1 migration `src/migrations/20261010_080422_audit_logs.ts` creates only `audit_logs` and `audit_logs_changes`. It does not create `payload_kv`. See [src/audit/README.md](src/audit/README.md).
