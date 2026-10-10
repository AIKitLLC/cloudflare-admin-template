# Audit trail

Field-level history for Payload collections on Cloudflare D1. Administrators can see who changed a record, which columns moved, the old and new values, the client IP, the user agent, and when it happened.

## What gets stored

Collection: `audit-logs` (admin label **Audit Logs**, D1 table `audit_logs`).

| Column | Meaning |
| --- | --- |
| `action` | `CREATE`, `UPDATE`, or `DELETE` |
| `collectionSlug` | Collection that changed |
| `documentId` | Record id (text, so numeric and string ids both fit) |
| `actor` | Relationship to `users` (`actor_id`). Set null if that user is later deleted |
| `operatorId`, `actorEmail` | Operator snapshot. These survive user deletion. `operatorId` is its own column so it does not collide with the relationship |
| `ipAddress` | `cf-connecting-ip`, else the first `x-forwarded-for` hop, else `x-real-ip` |
| `userAgent` | `User-Agent` header |
| `occurredAt` | Timestamp of the audit row |
| `changes[]` | `{ path, oldValue, newValue }` for each changed field |

`createdAt` / `updatedAt` on the audited document are ignored. They move on every write and hide the real diff.

## Opting a collection in

`withAuditTrail` is a decorator around a `CollectionConfig`. It appends four hooks and leaves the rest of the config alone.

```typescript
export const Customers = withAuditTrail(
  { slug: 'customers', fields: [...] },
  { redactFields: ['billingToken'] },
)
```

Wired today: `users` and `media`.

Do not wrap `audit-logs`. The helper throws. The record hooks also ignore that slug so a mistake cannot recurse.

## How a change is captured

1. `beforeChange` clones `originalDoc` (null on create) and reads actor, IP, and user agent onto `req.context`. The key is the string `__auditTrail`. Payload copies context with object spread, which drops symbols.
2. The collection write runs.
3. `afterChange` pops that snapshot and diffs it against the saved `doc`. The raw row includes hidden auth fields (`hash`, `salt`, `loginAttempts`) that `afterRead` removes before `afterChange`. Those before-only keys are dropped so they are not logged as cleared. Nested groups become dotted paths (`address.city`). Arrays are one value so reordering is visible.
4. `beforeDelete` stores the same request metadata. `afterDelete` diffs the deleted document down to null. Payload does not run beforeChange/afterChange for deletes.

Updates with no business-field diff (only `updatedAt`) do not insert a row. Creates and deletes always do.

## Secrets

`SensitiveFieldPolicy` is a composite strategy:

- `PatternSensitivityRule` matches password, secret, token, api key, credential, private key, session, and names ending in `hash` or `salt`.
- `ExplicitFieldSensitivityRule` matches `redactFields` passed to `withAuditTrail`.

A sensitive path is stored as `[REDACTED]` on both sides when it actually changed. The raw value is not copied into the change object.

Payload auth never persists `password` on the document; it stores `hash` and `salt`, then removes `password` from `data` before `afterChange`. `beforeChange` records only the names of sensitive fields that were submitted. The audit row says `password` changed and stores `[REDACTED]`, never the secret. Hash, salt, reset tokens, and sessions are redacted if they remain on the saved document.

Redaction also walks nested objects and arrays, so a token inside a JSON blob is not written when the parent object is logged.

## Append-only

`src/audit/access/AuditLogAccessPolicy.ts` is the only access decision:

- `read` and `admin`: any authenticated user
- `create`, `update`, `delete`: denied

Hooks create rows with `overrideAccess: true`. `rejectAuditLogUpdate` and `rejectAuditLogDelete` still throw, including when `overrideAccess` is set, so a normal admin API call cannot edit or delete history. Raw SQL against D1 is outside this app.

The `actor` relationship uses `ON DELETE SET NULL` (Payload's simple relationship). Deleting a user does not delete their audit rows. `operatorId` and `actorEmail` remain.

## Failure isolation

An audit failure must not fail the user's write.

The D1 adapter's `beginTransaction` is a no-op unless `transactionOptions` is configured, so the user's row is committed before `afterChange` returns. A thrown hook would still turn the HTTP call into an error. `runAuditChange` / `runAuditDelete` catch every error, log `err` plus a message that does not include field values, and return.

`PayloadAuditLogWriter` is a second line of defense for when transactions are turned on later:

- It does not receive the caller `req`, so it cannot join that transaction id.
- It sets `disableTransaction: true`.
- If the operator foreign key points at a user that was just deleted, it retries once with `actor: null`.

`FailOpenAuditLogWriter` decorates that writer and swallows a still-failing insert.

Tradeoff: the audit row is not atomic with the user's row. A crash between the two can leave a change without a log, or (once real transactions exist) a log whose parent transaction later rolls back. That is accepted so logging cannot roll back or 500 the user's write.

## Admin viewer

The Audit Logs list is the viewer. Columns include timestamp, action, collection, record id, operator, and IP. The list is searchable on those identifiers.

`AuditLogFilterBar` sits above the list and updates Payload's list query through `handleWhereChange`. Writing the URL alone is not enough: the list view keeps the previous `where` and puts it back. The resulting query is:

- Record ID → `where[documentId][equals]`
- Collection → `where[collectionSlug][equals]`
- Operator → `where[operatorId][equals]` when the value is all digits, otherwise `where[actorEmail][contains]`

The native column filters remain available.

## RBAC follow-up (issue #1)

Do not scatter checks. When the permission matrix exists, change `authenticatedOperator` in `AuditLogAccessPolicy.ts` so `read` and `admin` call `hasCollectionPermission(user, 'audit-logs', 'read')`.

Leave `create`, `update`, and `delete` returning false. Append-only is not something a role should grant by having update/delete on other collections. Keep the reject hooks so `overrideAccess` cannot mutate history. Field-level permissions from #1 should not make audit fields writable.

## Local test

```bash
pnpm test:int
```

Unit cases cover the diff, redaction, the filter query, and fail-open behavior. The integration case boots Payload against local D1 (Wrangler, not a remote database).
