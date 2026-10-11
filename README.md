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
│   ├── audit/               # Opt-in field-level audit trail (see src/audit/README.md)
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

```bash
# Run unit & integration tests
pnpm test:int

# Run end-to-end Playwright tests
pnpm test:e2e
```

---

## 📄 License

MIT © [AIKit LLC](https://github.com/AIKitLLC)

## Audit trail

`Users` and `Media` record an append-only, field-level audit row on create, update, and delete. Opt another collection in with `withAuditTrail` from `src/audit`. Passwords, tokens, hashes, salts, sessions, and similar secrets are stored as `[REDACTED]`. A failed audit write is counted, logged, and does not fail the user's change.

`untrustedClientIp` is personal data visible to anyone who can read the trail. Reads are a hard gate: only the single earliest user or an exact `AUDIT_LOG_READER_EMAILS` entry may read, and a failed lookup denies access. The D1 migration `src/migrations/20261010_080422_audit_logs.ts` creates only `audit_logs` and `audit_logs_changes`. It does not create `payload_kv`. See [src/audit/README.md](src/audit/README.md) for the viewer filters and how `canReadAuditLogs` will return the `audit-logs:read` decision once the permission matrix from issue #1 is available.
