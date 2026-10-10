# Organizational row scope

Row scope narrows which documents a signed-in user can read, update, delete, and export after the RBAC permission grant succeeds. It is registered with `registerRowScopeContributor` and does not replace collection access functions. Full-access roles never enter this contributor. Self-service on `users` still returns its own `Where` when the caller has no collection grant, and that own-document `Where` is not narrowed again. A caller who does have `users:read`, `users:update`, `users:delete`, or `users:export` is limited to user accounts whose direct assignments sit inside the caller's inherited scope.

The example collection is `records`. Organizations, branches, and data classes are scope dimensions and are themselves filtered.

## Dimensions

| Collection      | What an assignment means                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `organizations` | That organization and every descendant. Also every branch whose organization is in that set.              |
| `branches`      | That branch and every descendant branch. The branch's own organization is visible on records and on read. |
| `data-classes`  | That class and every class nested under it. A parent is a group. Nested groups are included.              |

A record matches only when its `organization`, `branch`, and `dataClass` are all inside the caller's effective sets. An empty set matches nothing. A user with `records:read` and no assignments therefore sees no records. There is no unscoped grant for a limited role: the permission key does not carry a row limit, and the caller's scope is applied on every allowed read, update, delete, and export.

Implied access is one way:

- An organization assignment does not grant ancestor organizations or sibling trees.
- A branch assignment does not grant sibling branches. It does add that branch's organization so the record's organization field can match, and it does not add descendant organizations of that org.
- Organization assignment is what grants branches. The organization ids a user may assign to someone else are only the assigned organizations and their descendants (`grantableOrganizationIds`). A branch-only user can read the branch's organization and cannot update it, reparent it, or assign it.

## Where it runs

`contributeRowScope` returns a Payload `Where` for `read`, `update`, `delete`, and `export`. `create` stays a boolean allow; a `beforeChange` hook rejects scope values outside the creator's effective scope, including a branch that belongs to a different organization.

Payload applies the `Where` to list queries, `findByID`, `count`, pagination (`totalDocs`, `hasNextPage`), GraphQL list queries, and deletes. `GET /api/{slug}/export` asks the access pipeline for the export decision and then reads with `overrideAccess: false`, so the export `Where` and the read `Where` both apply.

Organization reads use the broader set (assigned orgs, descendants, and orgs reached through a branch). Organization updates and deletes use only `grantableOrganizationIds`.

## Hierarchy and cycles

Each dimension stores `parent`. `ScopeTree` builds the child index in memory from one catalog snapshot.

- Assignment closure is a depth-first walk of children. It is not a query per node.
- On create and update, `guardScopeNode` walks ancestors from the proposed parent. The walk stops with a 400 if it reaches the node itself, repeats an id, or passes 32 nodes (`MAX_SCOPE_DEPTH`).
- A missing parent id is rejected, so a cycle cannot be hidden behind an unknown row.
- A limited user cannot create a root, clear a parent, or point a parent at a node outside their effective scope. They cannot move a branch into another organization.
- Full access and requests with no user (seed, `overrideAccess` without `req.user`) still run the cycle check when a parent is set. The same `skipRbacPrivilegeChecks` context used by RBAC skips the authorization half.
- Delete is refused with a 400 while a child node, a branch in that organization, a record, or a user assignment still points at the node. The foreign keys would otherwise set those references to null and hide the rows from every limited user. The check runs for full access too. Delete children, records, and assignments first.

## Request cache

Scope decisions must not fan out into N+1 D1 reads while Payload checks access, fields, and hooks.

For one request and one user, the first check loads three catalogs (`organizations`, `branches`, `data-classes`) with `pagination: false`, `depth: 0`, and `overrideAccess: true`, plus one `findByID` of the caller's assignments. The promises are stored on `req.context` (`rowScopeCatalog`, `rowScopeEffective`). Later checks in that request await the same promises. Descendant closure then happens in memory.

`overrideAccess` on those reads keeps the catalog load out of the access pipeline, so the contributor cannot recurse. Writes to a dimension collection or to user assignments clear the request cache in `afterChange` / `afterDelete`, so a child created earlier in the same request is visible to the next check.

This assumes the scope tables fit in a single read. A much larger tree would need a different cache; the `Where` would still be a single `in` list rather than a query per row.

## Scope escalation

RBAC's subset check compares permission keys only. Row scope adds these refusals for anyone who is not full access. They run for REST, GraphQL, and `POST /api/rbac/grants` (that route calls the same grant guard as the collection hook, and the hook runs again on the write).

- A user cannot change their own `organizations`, `branches`, or `dataClasses`, even to a smaller set. The check is in `beforeOperation`, before field access can drop the values, and again in `beforeChange`.
- Scope ids added to another user must already be inside the actor's effective scope, including inherited ids. Ids the actor cannot hold are kept if they were already on the user, so a partial form cannot strip a wider assignment. Adding any new scope id also requires that every permission key on the target's roles is one the actor already holds, and that the target does not hold a full-access role. Otherwise a limited admin could extend a more privileged account into the admin's own organizations.
- A role can be assigned only when the target user's effective scope is inside the actor's. A permission can be granted (`granted: true`) only when every non-full-access holder of that role is inside the actor's scope. Revoking a grant is unchanged. Holders are loaded with one users query, then resolved against the cached catalog.
- Record creates and updates cannot set `organization`, `branch`, or `dataClass` outside the actor's effective scope.

Empty holder scope is inside any actor scope. That holder still sees no scoped rows until someone who covers those rows assigns scope.

## Adding a scoped collection

Pass `rowScope` to `withRbac`. The helper appends `guardRecordScope`, which enforces the write. The contributor reads the same options from `custom.rbac` and filters reads.

```ts
export const Customers = withRbac(
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
)
```

Omit a field name to skip that dimension. A configured dimension with no assignments matches nothing. Restart so the permission catalog picks up the collection, then grant keys in the matrix. Users still need an assignment in every configured dimension.

`records` is the reference collection. Scope-node collections use `rowScope.dimension` (`organization`, `branch`, or `data-class`). `users` uses `rowScope.assignments`, which does two things: the assignment guards, and a `Where` of user ids whose stored organizations, branches, and data classes are all inside the caller's effective sets. An account with no assignments is inside every scope. An account that also holds another organization, branch, or data class is hidden from read, update, delete, and export. The caller's own id is always included, so a granted user can still open their own account. The id list is loaded once per request (`pagination: false`, `depth: 0`, `overrideAccess: true`) and cached next to the catalog.

## Migrations

`src/migrations` registers the row-scope migration next to the RBAC migration and passes the list to the D1 adapter as `prodMigrations`. Local development pushes the Drizzle schema when `NODE_ENV` is not production. Production applies `prodMigrations` on connect. Run `pnpm payload migrate` against the target D1 database before relying on a deploy.

The latest migration JSON snapshot matches the Drizzle schema. A fresh `pnpm payload migrate:create` should come out empty until the next collection change.

`down` does not use `PRAGMA foreign_keys`. D1 ignores that pragma and keeps foreign keys enabled. The down migration first rebuilds `users_rels` and `payload_locked_documents_rels` without the scope columns, copying only rows that still belong to the previous relationships, then drops `records`, `branches`, `data_classes`, and `organizations`. Scope rows that would have been copied with a null role or lock target are left behind in the dropped tables.

## If the RBAC branch changes before merge

This work is stacked on the permission-matrix branch. Rebase onto it if that branch moves. The row-scope code depends on these RBAC contracts:

- `runAccessPipeline` still calls `applyRowScope` only after the permission grant returns `true`, and full access still returns before that.
- `registerRowScopeContributor` still appends to the shared list and contributors still return `Where | undefined`.
- `RbacCollectionOptions` still lives on `custom.rbac`. `withRbac` must keep spreading `rowScope` into that object and appending the scope hooks instead of replacing collection hooks.
- `assertMayChangeRoleGrant` must keep receiving `granted`. The holder check runs only when that flag is `true`. The matrix route and the role-permission hooks pass it through.
- `skipRbacPrivilegeChecks`, `userGrantsFullAccess`, and `loadUserGrants` keep their current meaning. Scope guards return without checking when the user is missing or the skip flag is set, same as the privilege hooks.
- Export must keep evaluating access and then querying with `overrideAccess: false`.

A change to the key subset rule, the full-access lock, or field-level access should be rebased through, not reimplemented here. If self-service starts returning a `Where` for users who also have a collection grant, user reads would skip row scope; user documents are not row-filtered today, so that only matters if user visibility is later tied to scope.

## Permission matrix

`GET /api/rbac/matrix` still lists every role and every active permission. Roles are a global catalog, not an organizational tree, so the grid is not filtered by scope. The response is read-only. Creating or changing a grant still goes through `assertMayChangeRoleGrant`: a limited user can grant only keys they hold, and only when every non-full-access holder of that role is inside their scope.

## Follow-ups

- Revoking a grant is allowed even when a holder sits outside the actor's scope. The check blocks new grants only.
- The holder check, the permission-subset check on scope extension, and the hierarchy check are check-then-write, same as the last full-access assignment. Two overlapping requests can both pass.
- A full-access account with no scope assignments is visible to a limited reader, because an empty assignment is inside every scope. Modify and delete of that account still have to satisfy the permission-subset rule from the RBAC branch.
- The catalog read loads every scope node, and the user filter loads every user id once per request. That is the wrong shape for a very large tenant.
- Bulk user updates are enforced per document in `beforeChange`, after field access. A bulk payload that field access drops cannot change scope; a by-id update is refused in `beforeOperation` even when field access would have dropped it.
