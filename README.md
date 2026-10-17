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

> **Note on Workers plans:** Cloudflare limits Worker size to **64 MiB uncompressed on both the Free and Paid plans**, with no compressed size limit ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#worker-size)). A local build of this template produces about 15.5 MiB uncompressed (about 3.6 MiB gzip), so bundle size alone does not require Workers Paid. CPU time per request (10 ms on Free) and the 1 second startup limit have **not been measured** yet; check them with `wrangler` and Workers Logs before choosing a plan.

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

Open [http://localhost:3000/admin](http://localhost:3000/admin) to access the admin panel and create your initial administrator account.

---

## 🛠️ Project Structure

```text
├── src/
│   ├── app/                 # Next.js App Router (Admin & API endpoints)
│   ├── collections/         # Payload Collection definitions
│   │   ├── Users.ts         # User authentication collection
│   │   └── Media.ts         # Asset upload collection (R2)
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

Define your collections using TypeScript code in `src/collections/`:

```typescript
import type { CollectionConfig } from 'payload'

export const Customers: CollectionConfig = {
  slug: 'customers',
  admin: {
    useAsTitle: 'name',
  },
  access: {
    read: ({ req: { user } }) => Boolean(user),
  },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'email', type: 'email', required: true, unique: true },
    { name: 'status', type: 'select', options: ['active', 'suspended'], defaultValue: 'active' },
  ],
}
```

Add your collection to `src/payload.config.ts`:

```typescript
import { Customers } from './collections/Customers'

export default buildConfig({
  collections: [Users, Media, Customers],
  // ...
})
```

Generate updated TypeScript types:

```bash
pnpm generate:types
```

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

### 2. Run Database Migrations & Deploy

```bash
pnpm payload migrate:create
pnpm run deploy
```

---

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
