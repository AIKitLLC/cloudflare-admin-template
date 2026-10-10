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

> **Note:** Deploying Next.js via OpenNext on Cloudflare Workers currently requires the **Cloudflare Workers Paid** plan due to worker bundle size requirements (>3MB).

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

- **Super Admin** (`grantsFullAccess`) bypasses the matrix. The first user receives this role. Existing users with no roles receive it once, on the first seed after upgrade, and that promotion does not run again.
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

### 2. Run Database Migrations & Deploy

```bash
pnpm payload migrate
pnpm run deploy
```

`pnpm payload migrate` applies the committed migrations, including the RBAC tables. `pnpm payload migrate:create` only scaffolds a new migration file after you change a collection. It does not update D1.

---

## 🧪 Testing

```bash
# Run unit & integration tests
pnpm test:int

# Run end-to-end Playwright tests
pnpm test:e2e

# Compile the Next.js app (Payload 3.82 has no `payload build` command)
pnpm build
```

---

## 📄 License

MIT © [AIKit LLC](https://github.com/AIKitLLC)
