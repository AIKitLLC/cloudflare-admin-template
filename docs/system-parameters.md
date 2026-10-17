# System parameters

Operational settings (thresholds, feature flags, maintenance mode, public API base URLs) live in the `system-parameters` collection so an administrator can change them without a Worker deploy. Credentials do not belong here.

Access control is the RBAC pipeline from `docs/rbac.md`. This feature does not add a second permission system.

## Data model

| Field         | Rules                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key`         | Required, unique, lowercase kebab-case, at most 64 characters. Case is significant only because uppercase is rejected, so `Feature-Flag` and `feature-flag` cannot both exist. |
| `category`    | Required group slug with the same format. Examples: `billing`, `features`, `operations`.                                                                                       |
| `label`       | Optional display name.                                                                                                                                                         |
| `description` | Optional operator note.                                                                                                                                                        |
| `valueType`   | `string`, `number`, `boolean`, or `json`.                                                                                                                                      |
| `value`       | JSON column. Must match `valueType`. `0`, `false`, and `""` are valid. `null` is not.                                                                                          |
| `sensitive`   | Optional. Default `false`. See below.                                                                                                                                          |

`json` values must be a JSON object or array. A JSON string, number, boolean, or `null` is rejected for that type; use `string`, `number`, or `boolean` instead. A string that is not valid JSON is rejected with a JSON syntax error. Objects and arrays are limited to 32 KiB serialized and 32 levels deep. Strings are limited to 8,192 characters.

Validation runs in collection `beforeChange` and on the field `validate` functions, so REST and GraphQL both reject bad input.

## Secrets

Values are stored unencrypted. D1 keeps `value` as plaintext JSON text, and the optional KV cache entry stores the same plaintext so `getParameter` can read it. This collection is not an encrypted secret store and is not meant for credentials. Put credentials in Worker secrets (`wrangler secret put`).

Two separate controls, and neither one makes the column safe for secrets:

1. **Secret-like keys are refused.** This is only a heuristic. A key is rejected when a `-` segment is `secret`, `secrets`, `password`, `passwd`, `token`, `tokens`, `apikey`, `credential`, `credentials`, or `privatekey`, or when it contains `api-key`, `access-key`, or `private-key`. Examples that are rejected: `api-key`, `stripe-secret`, `session-token`. Name a lifetime `session-ttl-seconds` instead of `token-ttl`. An ordinary key such as `billing-allowlist` is accepted even if the operator pastes a credential into it.
2. **`sensitive` hides operational values that are not credentials.** The value is still stored in plaintext, because server code may need it, but it is not a plain parameter on any API surface.

Chosen this way because a denylist alone misses a secret stored under an innocent key, and a mask flag alone would still let `api-key` be written into D1. The denylist blocks credential-shaped names. The flag covers everything else an operator must keep out of list, export, and audit output.

When `sensitive` is true:

- REST, GraphQL, list, find-by-id, mutation responses, and `GET /api/system-parameters/export` return `value: null`. The row stays so it can be edited. `sensitive: true` distinguishes a mask from a missing document.
- `getParameter` is the only supported reader of the plaintext. It is server-side and sets `revealSensitiveParameterValue` on the local request.
- The CSV export uses the normal read path, so the plaintext never reaches the file.
- Sending `value: null` on update keeps the stored value while the row stays sensitive. That is how a masked admin form can save a label without wiping the value. Rotate a sensitive value by sending a new one. Delete the row to remove it.
- Payload versions are off, so old plaintext is not copied into a versions table.

Clearing `sensitive` (true to false) is not a reveal. Both of these rules apply:

- Only a full-access user can make that change. A local API call with `overrideAccess: true` may also do it, because that path is server code rather than a logged-in editor. Every other caller is rejected.
- The same request must include a new `value`. Omitting `value`, or sending `value: null`, is rejected. The stored value is left in place, stays sensitive, and is not returned in the error.

A user who can update a row cannot read it back by unchecking `sensitive`.

Filtering or sorting on `value` is refused for anyone who does not have full access. The check walks every `where` key, at any depth, under `and` / `or` in any casing. A path counts when its first segment is `value`, after `__` is read as `.`, so `value`, `value.flag`, `value__flag`, and `-value` are all refused. The same rule covers list, count, GraphQL `where` and `sort`, CSV export, and `findDistinct` `field`. That blocks guessing a sensitive value one character at a time through `totalDocs` or a filtered export. Full-access users may filter and sort on `value`. `getParameter` looks up by `key` and is unaffected.

## Permissions

`SystemParameters` is wrapped with `withRbac`. The matrix keys are:

- `system-parameters:create|read|update|delete|export`
- `system-parameters:readField:<field>` and `system-parameters:writeField:<field>`

A full-access role bypasses these, same as every other collection. Field writes without `writeField` are dropped by the existing field gate; collection update without `system-parameters:update` is denied. Restart after deploy so catalog sync inserts the new permission rows, then grant them in the matrix.

`getParameter` uses `overrideAccess` because Workers read configuration with no logged-in user. That does not open the HTTP API.

## Audit trail (#12)

Parameter changes go through normal collection hooks. Nothing writes a parameter document with raw SQL, and these hooks do not mutate `data`, `doc`, or `previousDoc`. Those objects can still hold plaintext. Issue #12 must not read `value` from them.

The `value` field is marked `custom.audit.redact = 'whenSensitive'`. When `sensitive` is true, redact that field. When it is false, keep the submitted value.

`redactSystemParameterForAudit(doc)` returns a copy with that rule applied. It does not modify `doc`. Call it on whichever document the hook received (`doc`, `previousDoc`, or the merged write). It is safe no matter which hook runs first, including a hook registered before this collection's `afterChange`.

`req.context.systemParameterAudit` is a map of those redacted records keyed by document id, so a bulk write does not overwrite a sibling row. Updates publish the map in `beforeChange`, before any `afterChange` hook. Creates and deletes publish it in `afterChange` / `afterDelete`. `readSystemParameterAudit(context, id)` returns one entry. `readSystemParameterAudits(context)` returns the map.

When the two features are combined, #12 should take `value` only from `redactSystemParameterForAudit(doc)` or from `readSystemParameterAudit(req.context, id)`. Never from the raw documents.

## Reading from server code

```ts
import { getPayload } from 'payload'
import config from '@payload-config'
import { getParameter } from '@/system-parameters'

const payload = await getPayload({ config })
const maintenance = await getParameter(payload, 'maintenance-mode', { default: false })
```

A missing key returns `default`. A stored type that does not match the default throws `ParameterTypeMismatchError`. Omit `default` to receive the stored value or `undefined`.

## Cache

Each Worker isolate keeps a memory map of parameters. Memory is not shared across isolates, so a write clears only the isolate that handled it.

The shared invalidation signal is a monotonic integer in Payload's existing `payload_kv` table, key `system-parameters:version`. The `afterChange` and `afterDelete` hooks increment it with one SQLite `INSERT ... ON CONFLICT DO UPDATE` so two overlapping writes cannot lose an update. That statement is cache bookkeeping, not a parameter document, and it does not skip the parameter collection hooks.

`getParameter` uses memory only while all of the following hold:

- the entry was verified less than 2 seconds ago
- the memory generation is younger than 30 seconds
- the cached version equals the D1 version when the 2 second window has expired

After the 2 second window the isolate reads the D1 version. A mismatch drops memory and loads the row from D1. The writing isolate clears memory inside the hook, so its next read is fresh immediately. Every other isolate sees the new value on its next read after the 2 second window. That bound is the cross-isolate guarantee: staleness cannot outlive the verify TTL after a committed version bump.

The 30 second maximum age reloads from D1 even when the version still matches. It covers a process that saved the parameter and crashed before the version statement. A missed bump cannot pin a stale value for the life of the isolate.

Cloudflare KV is optional. The binding name is `SYSTEM_PARAMETERS_KV`. It is commented out in `wrangler.jsonc` with placeholder id `PLACEHOLDER_KV_NAMESPACE_ID` so this repo does not create a namespace. When the binding is absent, or the KV call throws, reads use memory and D1. When it is present, an entry is trusted only if its embedded version equals the D1 version. KV is eventually consistent and is never the source of truth. A stale KV entry fails the version check and the read falls through to D1. KV entries are plaintext, including sensitive values, because `getParameter` needs them. KV is not an admin, export, or audit surface, and it is not encrypted.

## Migrations

`system-parameters` is a normal Payload collection. Generate and apply D1 migrations the same way as the RBAC tables (`docs/rbac.md`). Local dev and tests push the Drizzle schema. Production applies `prodMigrations` on connect.

The version counter is a row in `payload_kv`, which already exists. It does not add a table.

## Tests

```bash
pnpm exec eslint src/system-parameters tests/int/system-parameters-http.int.spec.ts tests/int/system-parameters-cache.int.spec.ts tests/int/system-parameters-rules.int.spec.ts
pnpm exec tsc --noEmit
pnpm exec vitest run --config ./vitest.config.mts tests/int/system-parameters-rules.int.spec.ts tests/int/system-parameters-cache.int.spec.ts tests/int/system-parameters-http.int.spec.ts
pnpm exec payload migrate:create --skip-empty
```

`migrate:create --skip-empty` exits without writing a file when the latest snapshot matches the Drizzle schema.
