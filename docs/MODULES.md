# Admin modules

The app stays at the repository root. `wrangler.jsonc`, `open-next.config.ts`, `next.config.ts`, `custom-worker.ts`, and `scripts/worker-build` all assume that root. Moving the Next app to `apps/admin` would rewrite those paths without changing behavior.

Feature code lives in `packages/`. Each feature is a Payload plugin: `(options) => (config) => config`. Import the package entry only. Package `exports` does not expose internal files.

## Package map

| Package | What a product gets |
| --- | --- |
| `@aikit/admin-core` | The `whenSensitive` audit flag and the `payload-` internal-collection check. |
| `@aikit/admin-rbac` | Roles, permissions, role-permissions, the permission matrix, `withRbac`, and the startup seed. |
| `@aikit/admin-rls` | Organizations, branches, data classes, records, and row filters. Depends on RBAC's public registration API. |
| `@aikit/admin-params` | The system-parameters collection and `getParameter`. |
| `@aikit/admin-audit` | The audit-logs collection and `withAuditTrail`. Reads the core redact flag. Does not import params. |
| `@aikit/admin-jobs` | The jobs collection, the job monitor, and queue/cron dispatch helpers. The Worker entry imports `@aikit/admin-jobs/worker` so the outer Worker does not bundle the Payload plugin. |

Plugin order in `src/payload.config.ts`:

1. `adminRbac()`
2. `adminRls()`
3. `adminParams()`
4. `adminJobs()`
5. `adminAudit({ trails })`

Audit is last so its wrapper sits outside `withRbac`. `r2Storage` stays ahead of these because it is the storage adapter, not one of these features.

RBAC does not import RLS, jobs, or audit. RLS registers its row filter and its user/role scope checks through RBAC. Jobs registers `trigger` and `retry` through the same catalog. Audit registers `audit-logs:read` the same way. Audit Logs sets `custom.rbac.ownsAccess` and is not wrapped by `withRbac`.

## Adopt a package

Add the workspace dependency (or, later, a published version) and call the plugin from the product's Payload config. Pass `trails` to `adminAudit` for each collection whose changes should be logged. User accounts in this template pass `redactFields` for password, hash, salt, reset token, and sessions.

Migrations stay in the app. Payload generates them into `src/migrations` when the composed config changes. Plugins do not ship SQL. After a package upgrade that changes a collection, run `pnpm payload migrate:create` in the app, review the SQL, and commit it. `@aikit/admin-rbac` also exports `seedRbac`, which the plugin already calls on startup.

## Versioning

Do not publish these packages from this repository yet.

Two ways to consume them from another repo later:

1. **Git tag.** Tag this repo (`admin-modules-3.82.1`) and depend on `git+https://github.com/AIKitLLC/cloudflare-admin-template.git#admin-modules-3.82.1`. Simple, no registry, and the tag can move only by a new tag.
2. **GitHub Packages.** Publish `@aikit/admin-*` with versions `3.82.x`, matching the Payload minor these plugins are written against. Better once more than one product installs them and needs a lockfile that is not a git SHA.

Use git tags until a second product is actually installing the packages. Switch to GitHub Packages when that install needs SemVer and a registry. Both stay on Payload 3.82.x until the plugins are updated for a newer Payload.
