# Admin access setup

How the first admin is created, how admin sessions are configured, and how sign-in is rate limited. Do these steps before the admin panel is reachable from the internet.

## First-admin bootstrap

Public sign-up does not create admins. A request that is not signed in can create a user only when the `users` table is empty and the request carries the setup token. Once any user exists, new users are created by a signed-in user with the `users:create` permission, from the admin panel or the API. The first user receives the Super Admin role (see the RBAC section of the README).

### Option A: CLI (recommended)

`pnpm admin:create` runs `scripts/create-first-admin.mjs` through the Payload CLI. It refuses to run when any user exists. The password comes from the `FIRST_ADMIN_PASSWORD` environment variable (at least 12 characters), so it is not part of the command arguments.

Local D1 (the database `pnpm dev` uses):

```bash
FIRST_ADMIN_PASSWORD='<password>' pnpm admin:create --email admin@example.com --confirm
```

Remote D1, after `pnpm run deploy:database` has applied the migrations. This uses your Wrangler login, like `deploy:database`:

```bash
NODE_ENV=production PAYLOAD_SECRET=ignore FIRST_ADMIN_PASSWORD='<password>' \
  pnpm admin:create --email admin@example.com --confirm
```

Set `CLOUDFLARE_ENV` as you do for `pnpm run deploy` if you use a Wrangler environment.

On a local database that was created with `pnpm payload migrate` instead of `pnpm dev`, the CLI's development-mode schema push can fail on an index that already exists. Run `pnpm admin:create` on a database created by `pnpm dev`, or with `NODE_ENV=production` against migrated D1.

### Option B: HTTP with a setup token

For automated setups, the first admin can be created over HTTP while the `users` table is empty:

1. Set the Worker secret `ADMIN_SETUP_TOKEN` (at least 32 characters) with `wrangler secret put ADMIN_SETUP_TOKEN`. Do not put it in `vars` or in the repository.
2. Send the request with the token in the `x-admin-setup-token` header:

   ```bash
   curl -X POST https://<your-host>/api/users/first-register \
     -H 'content-type: application/json' \
     -H "x-admin-setup-token: $ADMIN_SETUP_TOKEN" \
     --data '{"email":"admin@example.com","password":"<password>","confirm-password":"<password>"}'
   ```

3. Delete the secret afterwards with `wrangler secret delete ADMIN_SETUP_TOKEN`.

Without the secret, or without the header, the request is refused with 403. The admin panel's "create first user" screen does not send the header, so on a new install use one of the two options above.

## Put `/admin` behind Cloudflare Access

Before you open the Worker to the public, put the admin panel behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/). Create a self-hosted application for `<your-host>/admin` (and `/api` if only your team uses the API) with a policy that allows only your team's identities. Access then signs users in before any request reaches the Worker. Payload's own login still applies behind it.

## Admin session cookies

`src/auth/users-auth.ts` sets the `users` auth cookies to `Secure` when `NODE_ENV` is `production`, with `SameSite=Lax`. Local development over `http://localhost` keeps non-`Secure` cookies so sign-in works there.

## Sign-in throttling

Two limits apply in the Worker:

- **Per account:** Payload locks an account for 10 minutes after 5 failed sign-ins (`maxLoginAttempts`, `lockTime`).
- **Per client IP:** `src/auth/login-throttle.ts` counts sign-in attempts per `CF-Connecting-IP` in the D1 table `login_throttle` (migration `20261017_105600_login_throttle`). After 10 failed attempts in 15 minutes, `POST /api/users/login` and the GraphQL `loginUser` mutation answer 429 until the window ends. A successful sign-in does not count. Local API calls (`payload.login` in scripts and tests) are not counted.

### Cloudflare WAF rate limiting rule

Add a zone-level [rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) so that bursts are stopped at the edge before they reach the Worker. WAF rules apply to the Worker on a custom domain or route in your zone.

In the dashboard, open **Security** > **WAF** > **Rate limiting rules** and create a rule:

- **If incoming requests match:**

  ```text
  (http.request.method eq "POST" and http.request.uri.path in {"/api/users/login" "/api/graphql"})
  ```

- **With the same characteristics:** IP.
- **When rate exceeds:** Free plan: 5 requests per 10 seconds. Pro and above: for example 10 requests per 1 minute.
- **Then take action:** Block.
- **For duration:** Free plan: 10 seconds. Pro and above: for example 10 minutes.

Supported periods and durations depend on the plan; see the availability table on that page. If your GraphQL clients send many requests, narrow the second path or create a separate rule for it.
