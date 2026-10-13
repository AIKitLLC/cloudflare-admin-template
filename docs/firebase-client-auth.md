# Firebase native client authentication

`GET /api/client/v1/me` is an example protected client endpoint. It requires both
`X-Firebase-AppCheck: <App Check JWT>` and `Authorization: Bearer <Firebase ID token>`.
Both signatures and their claims must pass before the route handler runs. The ID
token must come from Firebase Anonymous Authentication. The response contains the
verified `{ uid, appId, projectId }` principal and is private with `no-store`.
This endpoint has no request body. New service endpoints should accept only their
business input, never a client-selected UID, quota identity, or administrator role.

This template has no native app, client-owned collection, or persistent quota store.
The example demonstrates authentication without adding an application domain or
changing the existing Payload Users, admin login, REST/GraphQL APIs, or public Media
access. Firebase principals are not Payload users or administrator sessions. In an
application with Telegram admin roles, keep that separate administrator check too.

## Public configuration required before activation

The route returns `503` until explicitly enabled with complete, valid configuration.
The real Firebase identifiers are still awaited; no values in this change identify
a production Firebase project. Supply these server-side Worker bindings from the
same Firebase project's settings:

| Binding                   | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `FIREBASE_CLIENT_ENABLED` | Exactly `true` after all other values are supplied                    |
| `FIREBASE_PROJECT_ID`     | Firebase project ID, used by the Authentication issuer and audience   |
| `FIREBASE_PROJECT_NUMBER` | Numeric Firebase project number, used by App Check                    |
| `FIREBASE_APP_IDS`        | Comma-separated allowlist of exact Firebase App IDs from that project |

For local development, copy `.dev.vars.example` to the ignored `.dev.vars` file and
fill in the public identifiers. For deployment, use the `vars` in `wrangler.jsonc`
(and repeat them for each environment). These are public configuration, not service
account credentials. Do not add service account private keys. The verifier fetches
only Firebase's public signing keys.

The Android app must be registered for App Check using the
[Play Integrity provider](https://firebase.google.com/docs/app-check/android/play-integrity-provider)
and use [Anonymous Authentication](https://firebase.google.com/docs/auth/android/anonymous-auth).
Provider setup, Anonymous sign-in enablement, Firebase security settings, and production
deployment are separate operational steps; this change does not perform them.
An App Check JWT identifies the app and project, but does not expose which attestation
provider minted it. Configure the intended provider in Firebase and avoid permitting
debug App Check tokens in production. Server signature verification alone cannot
prove that Play Integrity was the provider.

The native client should sign in anonymously once when it has no current user, retain
the Firebase session, and ask the Firebase SDK for a current ID token and App Check
token on each backend request. Use HTTPS and send both headers. Let the SDK cache and
refresh tokens; do not sign in anew for every call, hardcode tokens, log them, or place
them in URLs. No Origin header is required. An arbitrary Origin cannot bypass either
verification. This example adds no browser CORS permission or cookie authentication.

## Reusing the route adapter

`src/auth/firebase-client.ts` uses `jose` and Web Crypto, with no dependency on the
Node-only Firebase Admin SDK. `createFirebaseClientRoute` in
`src/auth/firebase-client-route.ts` supplies the verified, readonly principal as a
separate handler argument. Follow the `me` route's Worker binding lookup when adding
a Next.js App Router endpoint:

```ts
const handler = createFirebaseClientRoute(
  async (request, principal) => {
    // Validate this service's input independently. Identity comes from principal.uid.
    return Response.json({ uid: principal.uid })
  },
  { getEnv: getYourWorkerBindings },
)
```

The adapter returns `401` for missing or invalid credentials and `503` for disabled
or invalid configuration, unavailable keys, or failed binding lookup. Public errors
contain stable reason codes, never raw tokens or provider errors. Successful and
failed responses have `Cache-Control: private, no-store` and vary on both auth
headers. Authentication errors prevent the application handler from running.

## Ownership and quotas when adding service records

Persist both the verified `principal.projectId` and `principal.uid` when creating an
owned record. Select records using both fields in the database query, even when a
client supplies a record ID. For example, use a parameterized D1 query scoped with
`WHERE id = ? AND firebase_project_id = ? AND firebase_uid = ?` and bind only the
verified principal for the owner fields. `firebaseClientOwnsRecord(principal, record)`
provides the same exact comparison for a fetched record; a different project or UID
does not own it. Neither helper grants access through Payload's Local API. Its
`overrideAccess` defaults must be addressed explicitly when integrating application
collections; never forward Firebase bearer headers as a Payload login.

`firebaseClientQuotaKey(principal)` creates a collision-free JSON tuple of the project
ID and verified UID. Use it as the account key for your application's persistent quota
counter, with an atomic database increment/check or a Durable Object. For example,
in an application with a `client_quotas(account_key PRIMARY KEY, used)` table:

```ts
const quotaKey = firebaseClientQuotaKey(principal)
// Use a single atomic statement; zero returned rows means the quota was exhausted.
const result = await env.D1.prepare(
  `
  INSERT INTO client_quotas (account_key, used) VALUES (?, 1)
  ON CONFLICT(account_key) DO UPDATE SET used = used + 1 WHERE used < ?
  RETURNING used
`,
)
  .bind(quotaKey, limit)
  .first()
if (!result) return Response.json({ error: 'quota_exhausted' }, { status: 429 })
```

This is a schema example to adapt when adding a service, not a migration or active
quota in the starter. Validate a positive limit, define reset windows, and account
for failures/refunds according to that service's policy. Do not use an in-memory
Worker counter as a global quota or take a quota key from the request body. Protect
expensive work with quotas only after both token checks have passed.

An anonymous UID identifies a Firebase account, not an immutable installation or
physical device. A caller may create another account; clearing app data or reinstalling
may change its UID. Account quotas therefore cannot enforce a lifetime device limit.
App Check also does not provide absolute hardware proof, and these two tokens are
not cryptographically bound to one another. The local verifier checks signatures
and expiry, not ID-token revocation or whether an App Check token has already been
consumed. Replay consumption would require a separate supported Firebase operation.

## Verification and key lifecycle

App Check requires RS256, `typ: JWT`, the issuer containing the configured project
number, exact project audience membership, an allowlisted App ID subject, and numeric
`iat`/`exp`. ID tokens require RS256, the exact Secure Token issuer and project ID
audience, a nonempty subject of at most 128 characters, numeric `iat`/`exp`/`auth_time`,
and the anonymous sign-in provider. Future issuance/authentication and expired tokens
are rejected. Only `sub` from the independently verified ID token supplies the UID.

Each trust domain has its own bounded public-key cache and one shared refresh at a
time. Responses are capped at 128 KiB/20 keys, requests at 5 seconds, and App Check
cache lifetime at six hours. Provider `max-age`, `Age`, `no-store`, and `no-cache` are
honored. Unknown key refreshes have a 30-second cooldown and failed refreshes a
5-second backoff. Expired cached keys are never used during an outage. Token-controlled
key URLs and embedded public keys are rejected; redirects are not followed.

The implementation follows Firebase's official
[App Check custom backend verification](https://firebase.google.com/docs/app-check/custom-resource-backend)
and [ID-token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
requirements. The fixed key sources are
`https://firebaseappcheck.googleapis.com/v1/jwks` and
`https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com`.
[`jose`](https://github.com/panva/jose) provides Web Crypto signature verification.
The verifier was reviewed and adapted from
[TRIPP PR #45](https://github.com/AIKitLLC/tripp-chat-demo/pull/45), commit
`05de5b6c1e684fe5baba66e4eb857e4802767213`, without its service/domain logic.

Run `pnpm test:unit` for real synthetic RSA signatures, certificate/JWK verification,
adversarial claims, key rotation/outages/cache behavior, handler gating, and
ownership/quota identity tests. Run `pnpm test:firebase:runtime` for actual local
workerd verification with synthetic public-key responses; every outbound request is
intercepted, with no real Firebase or AI calls. The ignored `.qa/firebase-client/runtime.json`
records versions and source/lock hashes. Existing checks remain `pnpm lint`,
`pnpm typecheck`, `pnpm test:int`, and `pnpm build`.

`pnpm typecheck:firebase` checks the verifier, route adapter, actual Next.js client
route, and all unit tests with strict null checks independently of the starter's
other files.

At the initial template revision `80cea96eecb34ff78582cc892db1b67c33f96469`, full
TypeScript checking fails on three Payload CSS imports, `generatePayloadViewport`,
and `Config.storage`. The existing integration suite fails before running tests
because its jsdom environment breaks the `TextEncoder`/`Uint8Array` invariant used
by Wrangler's esbuild. The existing `payload build` script fails because Payload
does not have a `build` command. Each failure was reproduced on an untouched archive
of that revision using supported Node 24.15.0 and the same resolved dependencies.
These baseline issues remain separate from the Firebase implementation and prevent
claiming a full application build or integration-suite pass.
