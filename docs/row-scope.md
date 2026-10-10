# Organizational row scope

Row scope narrows which documents a signed-in user can read, update, delete, and export after the RBAC permission grant succeeds. It is registered with `registerRowScopeContributor` and does not replace collection access functions. Full-access roles never enter this contributor. Self-service on `users` still returns its own `Where` when the caller has no collection grant, and that own-document `Where` is not narrowed again. A caller who does have `users:read`, `users:update`, `users:delete`, or `users:export` is limited to user accounts whose direct assignments sit inside the caller's inherited scope.

The example collection is `records`. A second collection with different relationship field names is registered only from Vitest, so the filter is built from `rowScope` and is not tied to the `records` table. Organizations, branches, and data classes are scope dimensions and are themselves filtered. Each node stores `scopePath`, an ancestor path such as `/12/40/`. Reads match that column with one `contains` constraint per collapsed assignment, so a tree of more than 100 descendants does not become a bound-parameter list. Payload binds one parameter per `contains`. A branch assignment also matches its organization's path, so one assignment can add two constraints. Saving assignments refuses more than 20 direct organizations, branches, and data classes in total. D1 allows 64 tables in a join. On a record, each organization assignment joins the organization once and joins the branch plus its organization again, so the worst case is about 60 joins. That stays under the join cap, under the expression depth of 100, and under the 100 bound-parameter cap, with room for the caller's `where`, sort, and limit. Document `id IN` is inlined when `limitedBoundParameters` is set, so chunking an id list does not reduce bound parameters. Scoped collections do not use an id list. The access `Where` is JSON. It does not contain SQL. `GET /api/access` and the admin list and edit views receive that `Where` for scoped collections. User visibility is the exception described below: the id list is applied on the query and left off the access payload. That omission follows the permission-call argument shape, so a production bundle that renames `getEntityPermissions` still leaves the list off. Field access allows read and rejects create and update, so the access query can name the column and a client cannot write it. `syncScopePath` writes the column with one SQL statement. A move that already has a path replaces the old prefix on this node and every descendant in that statement (`newPrefix || substr(scope_path, …) WHERE scope_path LIKE oldPrefix || '%'`). A move whose stored path is null rebuilds the subtree from `parent_id` in one recursive update, because there is no prefix to swap. D1 applies each statement atomically, so one move cannot leave a subtree half-written. Two overlapping moves can still interleave: the parent write and the path statement are not one transaction, and the later statement can leave a descendant on the path the earlier request computed. Running the move again repairs a prefix swap.

## Dimensions

| Collection      | What an assignment means                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations` | That organization and every descendant. Also every branch whose organization is in that set.                                                                                            |
| `branches`      | That branch and every descendant branch. Records match the branch path and that branch's organization path. Organization read matches the organization path, including its descendants. |
| `data-classes`  | That class and every class nested under it. A parent is a group. Nested groups are included.                                                                                            |

A record matches only when its `organization`, `branch`, and `dataClass` are all inside the caller's effective sets. An empty set matches nothing. A user with `records:read` and no assignments therefore sees no records. There is no unscoped grant for a limited role: the permission key does not carry a row limit, and the caller's scope is applied on every allowed read, update, delete, and export.

Implied access is one way:

- An organization assignment does not grant ancestor organizations or sibling trees.
- A branch assignment does not grant sibling branches. It matches that branch's organization on record filters and on organization read. Organization read uses `scopePath` `contains`, so descendant organizations of that org are visible too. Those descendants are not grantable organization ids. A branch-only user cannot update, reparent, or assign the organization. The user-visibility check does not treat a branch assignment as covering descendant organizations.
- Organization assignment is what grants branches. The organization ids a user may assign to someone else are only the assigned organizations and their descendants (`grantableOrganizationIds`). A branch-only user can read the branch's organization and cannot update it, reparent it, or assign it.

## Where it runs

`contributeRowScope` returns a Payload `Where` for `read`, `update`, `delete`, and `export`. `create` stays a boolean allow; a `beforeChange` hook rejects scope values outside the creator's effective scope, including a branch that belongs to a different organization.

Payload applies the `Where` to list queries, `findByID`, `count`, pagination (`totalDocs`, `hasNextPage`), GraphQL list queries, and deletes. `GET /api/{slug}/export` asks the access pipeline for the export decision and then reads with `overrideAccess: false`, so the export `Where` and the read `Where` both apply. Export pages at 80 rows because D1 allows 100 bound parameters and Payload binds one id per row when it loads a page.

Organization reads match assigned organizations, their descendants, and organizations reached through a branch, including descendants of a branch's organization. Organization updates and deletes use only `grantableOrganizationIds`.

## Hierarchy and cycles

Each dimension stores `parent`. `ScopeTree` builds the child index in memory from one catalog snapshot.

- Assignment closure is a depth-first walk of children. It is not a query per node.
- On create and update, `guardScopeNode` walks ancestors from the proposed parent. The walk stops with a 400 if it reaches the node itself, repeats an id, or passes 32 nodes (`MAX_SCOPE_DEPTH`).
- A missing parent id is rejected, so a cycle cannot be hidden behind an unknown row.
- A limited user cannot create a root, clear a parent, or point a parent at a node outside their effective scope. They cannot move a branch into another organization.
- Full access and requests with no user (seed, `overrideAccess` without `req.user`) still run the cycle check when a parent is set. The same `skipRbacPrivilegeChecks` context used by RBAC skips the authorization half.
- Delete is refused with a 400 while a child node, a branch in that organization, or any collection that references the node through its `rowScope` config still points at it. Record fields and user assignment fields are discovered from those configs. The check runs for full access too. Delete children, records, and assignments first.
- The reference check counts rows and then Payload deletes. Two overlapping deletes can both observe zero references and both proceed, the same check-then-write window as the last full-access holder.

## Request cache

Scope decisions must not fan out into N+1 D1 reads while Payload checks access, fields, and hooks.

For one request and one user, the first check loads three catalogs (`organizations`, `branches`, `data-classes`) in pages of 80, with `depth: 0` and `overrideAccess: true`, plus one `findByID` of the caller's assignments. The promises are stored on `req.context` (`rowScopeCatalog`, `rowScopeEffective`). Later checks in that request await the same promises. Descendant closure for write guards happens in memory. Read filters do not expand that closure into an `in` list: they match `scopePath` on the scope column or on the related scope node.

`overrideAccess` on those reads keeps the catalog load out of the access pipeline, so the contributor cannot recurse. Writes to a dimension collection or to user assignments clear the request cache in `afterChange` / `afterDelete`, so a child created earlier in the same request is visible to the next check. The path is written in that same `afterChange`, derived from the parent. A parent move rewrites descendant paths in one prefix-swap `UPDATE` on the dimension table. When the stored path is null, the same hook rebuilds the moved node and its descendants from parent links in one statement. Records and user assignments read `scopePath` from the scope node, so they follow the move without a second write. Overlapping moves are not serialized with each other.

## Scope escalation

RBAC's subset check compares permission keys only. Row scope adds these refusals for anyone who is not full access. They run for REST, GraphQL, and `POST /api/rbac/grants` (that route calls the same grant guard as the collection hook, and the hook runs again on the write).

- A user cannot change their own `organizations`, `branches`, or `dataClasses`, even to a smaller set. The check is in `beforeOperation`, before field access can drop the values, and again in `beforeChange`.
- Scope ids added to another user must already be inside the actor's effective scope, including inherited ids. Ids the actor cannot hold are kept if they were already on the user, so a partial form cannot strip a wider assignment. Adding any new scope id also requires that every permission key on the target's roles is one the actor already holds, and that the target does not hold a full-access role. Otherwise a limited admin could extend a more privileged account into the admin's own organizations.
- Updating or deleting a user still has to pass the RBAC subset rule as well as this scope `Where`. A visible account whose keys are not a subset of the actor's cannot have its password, email, or other fields changed, and cannot be deleted. Full-access accounts are not in the `Where`, so a limited reader does not see them. The caller's own account stays editable.
- Unlock, forgot-password, and reset-password look the account up before the collection `Where` is applied. `guardAuthCredentialOperation` therefore checks the same scope rule after the permission-subset check. `access.unlock` still returns the `users:update` decision, so the id `Where` is a second filter on unlock. A logged-in user cannot unlock, start a reset for, or finish a reset for an account outside their scope. A public reset with no logged-in actor is unchanged.
- Moving a scope node under a new parent grants that node to every user assigned at the new parent or above it. The move is refused unless each user who would newly gain the node holds only keys the actor holds. Users who already had the node through the previous parent are not part of that check.
- A role can be assigned only when the target user's effective scope is inside the actor's. Assigning a role to the actor's own account skips that check; the permission-subset rule and the full-access lock still apply. A permission can be granted (`granted: true`) only when every non-full-access holder of that role is inside the actor's scope. Revoking a grant is unchanged. Holders are loaded with one users query, then resolved against the cached catalog.
- Record creates and updates cannot set `organization`, `branch`, or `dataClass` outside the actor's effective scope.

An account with no assignments is outside every limited scope. Only a full-access user can see it, and the account can still open itself. A limited caller cannot grant a new permission to a role that an unscoped account holds.

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

`records` is the reference collection. Tests register `work-notes` with `ownerOrganization`, `ownerBranch`, and `ownerClass` so the same filter runs against different field names. That collection is not in the production config, `payload-types.ts`, or `src/migrations`. Scope-node collections use `rowScope.dimension` (`organization`, `branch`, or `data-class`). `users` uses `rowScope.assignments`, which does two things: the assignment guards, and a user `Where`. A limited reader sees an account only when every assignment sits inside the caller's scope, the account is not full access, and it has at least one assignment, plus the caller's own row. Full-access accounts and accounts with no assignments stay hidden. Payload 3.82.1 cannot express that rule as a nested has-many `not_equals` Where, so the server selects the ids and the query `Where` is `{ id: { in: [...] } }`. The select joins the caller's `users_rels` rows and binds the caller id, so it does not grow with the number of assignments. An assignment whose path already sits under another assignment of the same caller is ignored. The id list is inlined, so it does not spend the 100 bound-parameter budget. The ceiling is SQLite's statement length: roughly 10,000 to 15,000 ids. Each limited-user list, count, by-id, update, delete, unlock, or export pays for that select once per request; the promise is cached on the request. `GET /api/access` and admin permission props call collection access with exactly `{ id, data, req }`, which is how Payload 3.82.1 builds permissions. Those calls omit the id list and report the RBAC grant. Queries go through `executeAccess`, which also passes `isReadingStaticFile`, so they still receive the list. Unlock uses the same argument check. Any other argument shape includes the list. The production bundle renames `getEntityPermissions`, and the argument shape is what keeps the access payload compact after that rename. Replacing the list with a nested has-many `not_equals` Where is a TODO until Payload ships that operator. Saving assignments drops a node when an assigned ancestor already covers it, and refuses more than 20 direct organizations, branches, and data classes in total (`SCOPE_ASSIGNMENT_LIMIT_ERROR`). Assign a parent instead of each descendant. An onboarding pool of unassigned accounts is not part of this filter.

## Migrations

`src/migrations` registers the row-scope migration next to the RBAC migration and passes the list to the D1 adapter as `prodMigrations`. Local development pushes the Drizzle schema when `NODE_ENV` is not production. Production applies `prodMigrations` on connect. Run `pnpm payload migrate` against the target D1 database before relying on a deploy.

The latest migration JSON snapshot matches the Drizzle schema. `20261010_110209_scope_path` adds `scope_path` and fills it from each node's parent chain. A fresh `pnpm payload migrate:create --skip-empty` should come out empty until the next collection change.

`down` does not use `PRAGMA foreign_keys`. D1 ignores that pragma and keeps foreign keys enabled. The row-scope down migration first rebuilds `users_rels` and `payload_locked_documents_rels` without the scope columns, copying only rows that still belong to the previous relationships, then drops `records`, `branches`, `data_classes`, and `organizations`. Rows that only pointed at a removed collection are left behind in the dropped table.

## If the RBAC branch changes before merge

This work is stacked on the permission-matrix branch. Rebase onto it if that branch moves. The row-scope code depends on these RBAC contracts:

- `runAccessPipeline` still calls `applyRowScope` only after the permission grant returns `true`, and full access still returns before that.
- `registerRowScopeContributor` still appends to the shared list and contributors still return `Where | undefined`.
- `RbacCollectionOptions` still lives on `custom.rbac`. `withRbac` must keep spreading `rowScope` into that object and appending the scope hooks instead of replacing collection hooks.
- `assertMayChangeRoleGrant` must keep receiving `granted`. The holder check runs only when that flag is `true`. The matrix route and the role-permission hooks pass it through.
- `skipRbacPrivilegeChecks`, `userGrantsFullAccess`, and `loadUserGrants` keep their current meaning. Scope guards return without checking when the user is missing or the skip flag is set, same as the privilege hooks.
- Export must keep evaluating access and then querying with `overrideAccess: false`.

A change to the key subset rule, the full-access lock, or field-level access should be rebased through, not reimplemented here. If self-service starts returning a `Where` for users who also have a collection grant, user reads would skip row scope.

## Permission matrix

`GET /api/rbac/matrix` still lists every role and every active permission. Roles are a global catalog, not an organizational tree, so the grid is not filtered by scope. The response is read-only. Creating or changing a grant still goes through `assertMayChangeRoleGrant`: a limited user can grant only keys they hold, and only when every non-full-access holder of that role is inside their scope.

## Follow-ups

- Revoking a grant is allowed even when a holder sits outside the actor's scope. The check blocks new grants only.
- The holder check, the permission-subset check on scope extension, the re-parent check, and the hierarchy check are check-then-write, same as the last full-access assignment. Two overlapping requests can both pass.
- Two overlapping moves of the same subtree are not one transaction. Each path statement is atomic, and the later one can leave a descendant on the path the earlier request computed. Run the move again to repair a prefix swap.
- Bulk user updates are enforced per document in `beforeChange`, after field access. A bulk payload that field access drops cannot change scope; a by-id update is refused in `beforeOperation` even when field access would have dropped it. A full-access account is omitted by the user `Where` before that hook runs.
- User visibility still pre-selects ids because Payload 3.82.1 has no nested has-many `not_equals`. The list stays off `/api/access`. Switch the query `Where` when Payload can express the rule directly. The practical ceiling until then is roughly 10,000 to 15,000 inlined ids.
