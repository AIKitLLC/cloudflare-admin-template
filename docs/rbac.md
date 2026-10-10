# Role-based access control

This template stores authorization in D1 and enforces it through Payload collection and field access. The admin permission matrix edits those rows. Later features should extend the pipeline in `src/access` instead of replacing collection `access` functions.

## Collections

| Slug               | Purpose                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `roles`            | Named roles. `grantsFullAccess` bypasses the matrix. The seeded slug is `super-admin`.                                                |
| `permissions`      | Catalog of actions. Startup sync creates and deactivates rows. API create, update, and delete are closed; seed uses `overrideAccess`. |
| `role-permissions` | Grant rows. `granted: false` is an explicit deny. A missing row is also a deny.                                                       |
| `users.roles`      | Has-many relationship to `roles`.                                                                                                     |

Permission keys:

- Collection action: `{collection}:{create|read|update|delete|export}`
- Field: `{collection}:{readField|writeField}:{dotted.field.path}`

Internal `payload-*` collections are not part of the catalog. Fields Payload already restricts (password hash, salt, reset tokens, sessions) keep that built-in access and are not listed in the matrix. `createdAt` and `updatedAt` stay readable.

## How a request is decided

`withRbac(collection, options)` installs collection `access` for create, read, update, and delete, adds `GET /api/{slug}/export`, and marks the collection so field access and the catalog include it. `onInit` then calls `applyFieldAccess` and `seedRbac`.

`evaluateCollectionAccess` loads the caller's grants once per request (`req.context.rbacUserGrants`) and runs this chain:

1. **Policy gates** (`beforeGrantGates`). A gate may return `false` to deny anyone, including full-access roles. Other results are ignored so a policy cannot skip RBAC.
2. **Unauthenticated**. No user is denied, except `anonymousRead` collections on `read` (media).
3. **Full access**. A role with `grantsFullAccess` is allowed and is not row-scoped.
4. **Permission grant**. The collection action key must be granted. Row-scope contributors then run.
5. **Self service**. On `users`, read and update of the caller's own document are allowed when no broader grant exists. The `roles` field stays locked so users cannot promote themselves.
6. **Deny**.

Field checks use the same grant cache. Collection read without field read returns the document with that field removed. Field write without permission drops the incoming value and does not throw.

Export requires the `export` action, then reads through normal access so read and field permissions still apply. The CSV is capped at 2000 rows.

## Defaults that avoid lockout

- The `super-admin` role is created on startup if it is missing, and `grantsFullAccess` cannot be turned off or the role deleted.
- Every active permission is granted to that role so the matrix shows a complete column. Unchecking it is rejected; the bypass does not depend on those rows.
- If the database has users and none of them have roles, all of them receive `super-admin`. That is the upgrade path from the pre-RBAC template.
- The first user created with no roles also receives `super-admin`, which covers the create-first-user screen after a fresh boot.
- Later users created without roles get no access until an administrator assigns one.

`access.admin` on users stays "any logged-in user", so a limited role can open the admin panel. Nav items still follow collection read permission.

## Admin UI

`/admin/permission-matrix` is a root admin view. It is linked after the nav items for users who can read `role-permissions`. Edits call `POST /api/rbac/grants`. `GET /api/rbac/matrix` returns the same grid plus `canEdit`.

## Adding a collection

```ts
export const Customers = withRbac({
  slug: 'customers',
  fields: [{ name: 'name', type: 'text', required: true }],
})
```

Optional `withRbac` options:

- `anonymousRead`: unauthenticated `read` is allowed. Signed-in users still need the read grant.
- `selfService` / `selfServiceLockedFields`: own-document read and update, with listed top-level fields excluded.

Restart after adding a collection so the catalog sync inserts the new permission rows, then grant them in the matrix.

## Extension points for later issues

Import from `src/access`:

| Later issue               | What to call                                    | Contract                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #2 Row-level scope        | `registerRowScopeContributor`                   | Return a Payload `Where` to narrow an allowed read, update, or delete. Not called for the full-access bypass. Self-service already returns its own `Where` and is not narrowed again. |
| #4 IP and schedule policy | `registerBeforeGrantGate`                       | Return `false` to deny. Run your own audit side effect in the gate if needed, but do not allow the request from this gate.                                                            |
| #3 Audit trail            | collection `beforeChange` / `afterChange` hooks | Do not put audit logging inside the access pipeline. Actor, IP, and user agent are available on `req`.                                                                                |
| #10 Script runner         | `userGrantsFullAccess(req)`                     | This is the super-admin check. It reads D1, not a role name hard-coded in the caller.                                                                                                 |

Grants are request-cached and loaded with `overrideAccess`, so field access cannot hide the caller's roles from the decision. Do not store request data on the gate objects; they live for the life of the worker.

## Migrations

Schema changes are Payload migrations under `src/migrations`, registered from `src/migrations/index.ts`, and passed to the D1 adapter as `prodMigrations`. Local development also pushes the Drizzle schema when `NODE_ENV` is not production. Production Workers apply `prodMigrations` on connect. Run `pnpm payload migrate` against the target D1 database before relying on a deploy.
