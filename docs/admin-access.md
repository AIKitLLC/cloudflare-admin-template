# Admin access setup

How the first admin is created, which Cloudflare Access setup production requires, how admin sessions are configured, and how auth requests are rate limited.

## First admin

A new install has no users. Create the first admin in one of two ways:

- **From the web (first-run admin setup).** Open `/admin` on the new deploy. While the `users` table is empty and setup has not completed, Payload shows its "create first user" screen (`/admin/create-first-user`). Submitting it calls `POST /api/users/first-register`, which creates the account with the Super Admin role and signs you in.
- **From the command line.** `pnpm admin:create` (below) does the same through the Payload Local API.

### Create the admin right after the deploy, or enable Access first

Until the first admin exists, whoever completes the setup screen first becomes that admin. Do one of these:

- **Recommended:** set up the Cloudflare Access application described below *before* the first deploy is reachable, then open `/admin` through Access and create the admin there. Access stays in place afterwards; it is required in production either way.
- Or open `/admin` immediately after `pnpm run deploy` finishes and create the admin straight away, then set up Access before you share the URL or store real data.

### How first-run setup works

`src/auth/first-admin-setup.ts` handles `POST /api/users/first-register` in place of Payload's built-in handler:

- **One admin, even with concurrent requests.** The D1 table `setup_state` (migration `20261017_130000_setup_state`) holds one row with a unique key. A single SQL statement claims it, and only while `users` is empty and setup has not completed, so exactly one request or CLI run can proceed. The others get 403 (web) or 409 (CLI). If a step fails, the account is removed and the claim released, so setup can be retried.
- **Super Admin role.** The new account is checked for the Super Admin role before setup is marked complete.
- **Closes permanently.** On success `setup_state.completed_at` is set. The web flow stays closed after that, even if every user is later deleted; the screen may still render on an empty table, but the form is refused. Installs that already have users are recorded as set up by the migration. Use `pnpm admin:create` to recover an empty `users` table.
- **Same-origin form.** Requests whose `Origin` is not the Worker's own origin or a configured CSRF origin (`PAYLOAD_PUBLIC_SERVER_URL`, `PAYLOAD_ALLOWED_ORIGINS`), or whose `Sec-Fetch-Site` is not `same-origin`, are refused.
- **Inputs.** Only the email and password are used, and the password must be at least 12 characters.
- **Throttled and logged.** The endpoint has its own per-IP limit (see [Auth request throttling](#auth-request-throttling)). Each first admin creation is logged as `First admin created` with the user ID, the email domain, and `source` (`web` or `cli`). The password and full email address are not logged.

After setup, `users` can be created over HTTP only by a signed-in user with the `users:create` permission, from the admin panel or the API.

### `pnpm admin:create`

`pnpm admin:create` runs `scripts/create-first-admin.mjs` through the Payload CLI. It takes the same `setup_state` claim, so two runs started at once create at most one user. It refuses when any user exists, but unlike the web screen it also works after setup has completed, as long as `users` is empty. The password comes from the `FIRST_ADMIN_PASSWORD` environment variable (at least 12 characters), so it is not part of the command arguments.

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

## Cloudflare Access is required in production

Production deployments must put Cloudflare Access in front of the admin panel and the `users` auth API: `/admin` and `/api/users/*`, which includes `/api/users/login`, `/api/users/first-register`, `/api/users/forgot-password`, `/api/users/reset-password`, and `/api/users/refresh-token`. Setting it up before the first deploy also covers first-run setup. Payload's own sign-in still applies behind Access. Access signs people in before a request reaches the Worker, so only your team's identities reach these routes.

Steps, in the Cloudflare dashboard:

1. Go to **Zero Trust** > **Access** > **Applications** and select **Add an application** > **Self-hosted**.
2. Add the public hostname of the Worker twice, once with path `admin` and once with path `api/users`. Access paths also cover everything under them. If the Worker is also served on its `workers.dev` hostname, add the same two paths for that hostname too, or turn off the `workers.dev` route.
3. Add an **Allow** policy for your team: specific emails, an email domain, or an identity-provider group.
4. If scripts or services call `/api/users/*`, create an Access **service token** and add a **Service Auth** policy for it. Those clients send the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers.
5. If the GraphQL endpoint (`/api/graphql`) is only used by your team, add path `api/graphql` as well.
6. Save, then open `https://<your-host>/admin` in a private window and check that Access asks you to sign in first.

See [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) and [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

### Account lockout and IP limits

The Worker applies two independent limits to sign-in (below). The per-account lockout counts failed sign-ins for one account from any address. The per-IP limit counts requests from one address across all accounts. With Access in front of `/api/users/*`, only your team's requests reach either limit, which is why Access is required in production.

## Admin session cookies

`src/auth/users-auth.ts` sets the `users` auth cookies to `Secure` when `NODE_ENV` is `production`, with `SameSite=Lax`. Local development over `http://localhost` keeps non-`Secure` cookies so sign-in works there.

## Auth request throttling

Limits applied in the Worker:

- **Per account:** Payload locks an account for 10 minutes after 5 failed sign-ins (`maxLoginAttempts`, `lockTime`).
- **Per client IP:** `src/auth/login-throttle.ts` counts requests per `CF-Connecting-IP` and operation in the D1 table `login_throttle` (migration `20261017_105600_login_throttle`). Within 15 minutes, each IP gets:

  | Operation | Routes | Limit |
  | --- | --- | --- |
  | Sign-in | `POST /api/users/login`, GraphQL `loginUser` | 10 failed attempts (successful sign-ins are not counted) |
  | Forgot password | `POST /api/users/forgot-password`, GraphQL `forgotPasswordUser` | 5 requests |
  | Reset password | `POST /api/users/reset-password`, GraphQL `resetPasswordUser` | 10 requests |
  | Refresh token | `POST /api/users/refresh-token`, GraphQL `refreshTokenUser` | 20 requests without a valid session (refreshes of a signed-in session are not counted) |
  | First-run setup | `POST /api/users/first-register` | 5 requests |

  Over the limit, the route answers 429 until the window ends. Expired rows are deleted during later writes. Local API calls (`payload.login` in scripts and tests) are not counted.
- **Production only:** a request without `CF-Connecting-IP` is refused with 400 (Cloudflare always sets it on requests that reach the Worker). If the D1 binding is unavailable, these routes answer 503 and the Worker logs an error once, instead of running without the limit. Outside production, requests without the header share one counter, and a missing binding skips the limit.

### Cloudflare WAF rate limiting rule

Add a zone-level [rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) so that bursts are stopped at the edge before they reach the Worker. WAF rules apply to the Worker on a custom domain or route in your zone, not on its `workers.dev` hostname.

In the dashboard, open **Security** > **WAF** > **Rate limiting rules** and create a rule:

- **If incoming requests match:**

  ```text
  (http.request.method eq "POST" and http.request.uri.path in {"/api/users/login" "/api/users/first-register" "/api/users/forgot-password" "/api/users/reset-password" "/api/users/refresh-token" "/api/graphql"})
  ```

- **With the same characteristics:** IP.
- **When rate exceeds:** Free plan: 5 requests per 10 seconds. Pro and above: for example 10 requests per 1 minute.
- **Then take action:** Block.
- **For duration:** Free plan: 10 seconds. Pro and above: for example 10 minutes.

Supported periods and durations depend on the plan; see the availability table on that page. If your GraphQL clients send many requests, drop `/api/graphql` from this rule or give it a separate rule with a higher rate.
