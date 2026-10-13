# Firebase native client authentication and admin controls

`GET /api/client/v1/me` requires both `X-Firebase-AppCheck: <App Check JWT>` and
`Authorization: Bearer <Firebase Anonymous Authentication ID token>`. Both signatures
and claims must pass, followed by atomic UID/IP/global rate admission, before work
starts. The response contains the verified `{ uid, appId, projectId }` principal,
uses `private, no-store`, and sets no login cookie. This endpoint has no body. New
service endpoints should accept only business input, never a client-selected UID,
quota identity, or administrator role.

Firebase principals are separate from Payload users and administrator sessions.
The template has no native app or domain-specific client records. Existing public
Media and ordinary CMS access are preserved; owner accounts and client security
settings receive additional protection. Applications with Telegram admin roles
must retain their separate administrator checks.

## Public configuration and owner management

An owner manages trust and quotas at `/admin/client-security`. Public project ID,
project number, and exact Firebase App IDs must all come from the same Firebase
project. No production identifiers have been guessed. Quotas are whole numbers
from 0 to 1,000,000 per window; the window is 10–3,600 seconds. Enabled policies
require complete valid identifiers and positive UID/IP/global quotas. Revision 0
starts disabled with blank identifiers and zero quotas.

Configuration is versioned in D1. The panel validates and previews the exact
change; saving requires its digest and expected revision. Stale saves return `409`.
Audit entries record the persisted owner ID, operation, time, and previous revision.
Rollback creates a new revision and retains history and active usage. Readiness
means the stored configuration is complete; it does not confirm provider setup.
The endpoint stores no tokens, secrets, private keys, or freeform audit messages.

Only the current persisted Payload `owner` can read or write controls. Existing
users migrate to `admin`; nobody is automatically promoted. Ordinary admins/editors
and Firebase principals cannot change roles or an owner's credentials. Creating a
normal default `admin` user retains existing CMS behavior. The final owner cannot
be deleted or demoted, including concurrent database writes. Payload password
recovery remains available through its actual recovery operations.

An approved operator establishes the first owner for one exact existing Users ID:

```sh
pnpm payload run scripts/bootstrap-client-security-owner.mjs -- --user-id <id> --confirm
```

Run in the explicitly selected environment after migration. This atomic claim
refuses if any owner exists. It is an operator capability, never an HTTP bootstrap
endpoint. Running it against a deployment changes security authority and requires
operator approval; installing this feature does not execute it.

Managed routes read only durable D1 configuration. The standalone verifier still
accepts `FIREBASE_CLIENT_ENABLED`, `FIREBASE_PROJECT_ID`, `FIREBASE_PROJECT_NUMBER`,
and comma-separated `FIREBASE_APP_IDS`, but those bindings cannot override the
managed route. Missing/corrupt state or unavailable storage fails closed with `503`.
Request handlers never initialize or repair state. The idempotent migration
preserves existing data, counters, and settings. Schema downgrade intentionally
refuses destructive removal; use the reviewed configuration rollback instead.

## Native app and reusable middleware

Register the Android app with the [Play Integrity provider](https://firebase.google.com/docs/app-check/android/play-integrity-provider)
and enable [Anonymous Authentication](https://firebase.google.com/docs/auth/android/anonymous-auth).
These provider/security operations and production activation are separate steps.
An App Check JWT identifies the app/project without revealing which attestation
provider minted it. Configure the intended provider and exclude debug providers in
production; backend signature verification alone cannot prove Play Integrity use.

Sign in anonymously when no user exists, retain that session, and obtain current
ID and App Check tokens through the SDK for each HTTPS backend request. Let the SDK
cache/refresh tokens. Do not create a new account each call, hardcode/log tokens,
or place them in URLs. Native authentication does not require or trust Origin.

`src/auth/firebase-client.ts` uses `jose` and Web Crypto, without the Node-only
Firebase Admin SDK. Use `createManagedFirebaseClientRoute` from
`src/client-security/client-route.ts` for automatic policy/authentication/admission:

```ts
export const GET = createManagedFirebaseClientRoute(
  async (request, principal) => Response.json({ uid: principal.uid }),
  { getDatabase: getYourD1Binding, getTrustedIp: getYourTrustedEdgeClientIp },
)
```

Follow the actual `me` route for OpenNext binding/context lookup. Missing/invalid
credentials return `401`; key/config/storage failure returns `503`; exhaustion
returns `429` and `Retry-After`. All auth/admission responses are private/no-store
and vary on both headers. Public errors contain stable codes, never raw tokens or
provider errors. Application errors remain the service's responsibility.

The IP adapter uses `CF-Connecting-IP` only with an incoming Cloudflare context,
rejects missing edge metadata/IP, and never trusts body or forwarded IP parameters.
Direct Node hosting requires a trusted proxy adapter. Review [Cloudflare header
semantics](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
for same-zone Worker subrequests and Pseudo IPv4 considerations.

## Rates and ownership

One [D1 batch transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
decides and charges all three counters. Denied requests charge none and cannot
create fresh UID rows. Stable bucket keys hash verified project/UID or normalized
edge IP and exclude configuration revisions. Changing limits/rolling back retains
usage; lower limits apply immediately. New window lengths apply after the existing
bucket expires. A trust revision changed during verification fails admission.
Admitted requests remain charged if the handler fails; paid-work refunds belong to
that service. Counters retain hashed identifiers; establish deployment retention
according to the service's data policy.

For future owned records, persist verified `principal.projectId` and `principal.uid`
and scope reads/writes with both fields. A parameterized query uses
`WHERE id = ? AND firebase_project_id = ? AND firebase_uid = ?`. The existing
`firebaseClientOwnsRecord` helper makes the same exact comparison, and
`firebaseClientQuotaKey` provides a collision-free identity tuple. Neither grants
Payload access; address Local API `overrideAccess` explicitly and never forward
Firebase headers as a Payload login.

An anonymous UID is an account, not an immutable installation/device. New accounts,
reinstalls, or cleared data can change it. App Check is not absolute hardware proof.
The tokens are not cryptographically bound to one another. Local verification
checks signatures/expiry, not ID-token revocation or App Check replay consumption.

## Verification and operational limits

App Check requires RS256, `typ: JWT`, configured project-number issuer/audience,
an allowlisted App ID subject, and numeric `iat`/`exp`. ID tokens require RS256,
exact Secure Token issuer/project-ID audience, a subject of 1–128 characters,
numeric `iat`/`exp`/`auth_time`, and anonymous provider. Future/expired claims fail.
Only the independently verified ID-token subject supplies UID.

Separate bounded key caches fetch fixed official URLs, never token-selected URLs:
`https://firebaseappcheck.googleapis.com/v1/jwks` and
`https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com`.
Requests cap at 5 seconds, responses at 128 KiB/20 keys, lifetime at six hours.
`max-age`, `Age`, `no-store`, and `no-cache` are honored. Unknown-key refresh cooldown
is 30 seconds; failed refresh backoff is 5 seconds. Ongoing outages remain `503`;
expired keys are never reused. Embedded keys and redirects are rejected.

Sources: [Firebase App Check custom backends](https://firebase.google.com/docs/app-check/custom-resource-backend),
[Firebase ID-token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens),
and [`jose`](https://github.com/panva/jose). The verifier was adapted from
[TRIPP PR #45](https://github.com/AIKitLLC/tripp-chat-demo/pull/45), commit
`05de5b6c1e684fe5baba66e4eb857e4802767213`, without Tarot/service logic.

Use Node >=24.15.0. Run `pnpm test:unit`, `pnpm test:int`, `pnpm typecheck`,
`pnpm typecheck:firebase`, and `pnpm lint`; then `pnpm build`, `pnpm test:api`,
`pnpm test:firebase:runtime`, and `pnpm build:worker`. Tests use synthetic signed
tokens, isolated real D1/R2, and actual workerd/compiled Next handlers. No Firebase
provider, paid inference, or deployment is invoked. Runtime evidence is written
under ignored `.qa/firebase-client`. Browser/provider acceptance remains separate.
Production R2 file download through a Node Miniflare proxy is not confirmed; local
development-adapter R2 CRUD is checked without claiming deployed storage acceptance.

The template's generic Payload `csrf` setting remains its empty default. The new
owner endpoint independently requires same-origin JSON POSTs with
`X-Client-Security-Action: manage` and rechecks the persisted owner before commit.
Deployment account, Worker/D1/R2 targets, real public Firebase configuration, and
explicit activation approval are still required before production rollout.
