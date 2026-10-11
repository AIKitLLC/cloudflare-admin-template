# Background jobs

Administrative work that does not fit in one HTTP request is a **job**. A job has a registered name, a JSON payload, a status, and timestamps. Operators watch those rows in the admin job monitor, and they can trigger a registered job or retry a failed one.

The statuses are `PENDING`, `RUNNING`, `SUCCESS`, and `FAILED`.

## What can run

Only names in the job registry run. `defineJob` registers a name, a payload validator, and an `execute` function. The admin UI and the API reject any other name. They do not accept a function, a file path, or a string of code.

`system.ping` is the only job shipped with the template. It records a short note and requires full access, so `jobs:trigger` alone cannot run it. A job can instead set `permissionKey` (for example `jobs:trigger:exports`) or `requiresFullAccess`. Jobs whose names start with `test.` can be registered from the test process. Production refuses those names.

Delivery is at-least-once. A crash after the handler's side effect and before `SUCCESS` is written can run the handler again when the lease expires. Handlers must be idempotent.

Do not put secrets in the payload. Keys are split on `-`, `_`, and camelCase boundaries, then refused when a segment is a secret word such as `password`, `token`, or `secret`, or when adjacent segments are `api` and `key`. `accessToken`, `clientSecret`, and `dbPassword` are refused. `author`, `passenger`, and `tokenCount` are accepted (`tokenCount` is an explicit exception). The handler receives the payload that was stored. Redaction applies to the monitor, API reads, stored errors and logs, and the documents passed to change hooks. Stored errors do not include stack traces. Pass a record id and load the secret at execution time.

## Delivery

1. The jobs row is written in D1 first. That row is the source of truth.
2. If the `JOB_QUEUE` binding exists, a message `{ jobId }` is sent. Retries use the queue `delaySeconds` for backoff.
3. If the binding is missing, the row stays `PENDING`. The cron runs it. `next dev` may also run it in-process with a timer, because the Node process stays alive. A Worker does not use that timer. Vitest does not auto-run jobs; tests call the runner.
4. If a queue send throws, the row stays `PENDING` for the cron.

The queue consumer and the cron both call the same claim function. A duplicate message, or a cron wake-up while a consumer is working, does not run the handler twice.

Deploying this branch enables the cron `*/5 * * * *`. It is active in `wrangler.jsonc` and starts firing as soon as the Worker is deployed, every five minutes. It does not require a queue. Each invocation reaps at most two expired leases and runs at most two due jobs. A counter on that run stops it before 40 counted D1 calls so the invocation stays under the Workers free-plan limit of 50 subrequests. The counter is passed through the job code. It does not wrap the shared D1 client, so another request in the same isolate is not counted and cannot fail that budget.

The `queues` block is commented out. Wrangler rejects a deploy that names a queue which does not exist. Leave the block commented until the queues exist, then replace `placeholder-jobs` and `placeholder-jobs-dlq`. Those names are not Cloudflare resources.

## Claim, lease, retry

A claim is one conditional `UPDATE`. It matches a `PENDING` row whose `runAt` is null or already due, or a `RUNNING` row whose lease has expired. A null `runAt` means the row is due immediately. The claim sets `RUNNING`, increments `attempt`, and stores a new `claimToken` and `leaseExpiresAt`. Two consumers cannot both match that statement.

The handler runs outside any database transaction. D1 does not keep a transaction open across the handler, and statements stay under the 100 bound-parameter limit. List queries are capped at 50 rows and page 20, and an `in` filter longer than 25 values is rejected.

While the handler runs, the runner renews the lease at one third of the lease interval. If a renewal does not match the claim token, the runner aborts the handler's `AbortSignal`. The completion update still has to match that token and `RUNNING`, so a handler that finishes after the reaper took the row cannot write `SUCCESS`. `maxAttempts` is the value stored on the row when the job was queued. The default budget is 5 attempts. Backoff is `min(base * 2^(attempt-1), 15 minutes)` with a 1 second base.

A handler error uses the same budget. The last attempt is stored as `FAILED` with a capped error string. That row is the application dead letter. The queue's own dead-letter queue is a separate placeholder for messages the consumer never acknowledges.

Manual retry is allowed only from `FAILED`. It resets `attempt` to 0 and sets `PENDING`. `SUCCESS` and `RUNNING` cannot be retried.

Status changes from the worker are conditional updates. Collection `beforeChange` and `afterChange` hooks still run afterward, including hooks a later audit wrapper appends to the jobs collection. The hook call is not inside the claim statement, so a hook error is logged and does not roll the row back.

## Permissions

Default deny, same as the rest of the matrix.

| Key | What it allows |
| --- | --- |
| `jobs:read` | The job monitor and `GET /api/jobs` |
| `jobs:trigger` | Queue a registered job that does not require a stronger grant (`POST /api/jobs`, `POST /api/jobs/trigger`, GraphQL `createJob`) |
| `jobs:retry` | Re-queue a failed job, together with the same privilege required to trigger that job (`POST /api/jobs/:id/retry`, GraphQL `retryJob`) |

`jobs:create`, `jobs:update`, `jobs:delete`, and `jobs:export` are not in the catalog. Job data fields carry their own read and create access, so they are not added as field permissions either. `jobs:read` sees the redacted payload, error, and logs. A trigger or retry caller also sees those fields on the document that mutation returns, and still cannot list jobs without `jobs:read`. `claimToken` stays hidden. Update and delete on the collection are closed, including for full access, so a client cannot rewrite status or delete history. Retry requires `jobs:retry` and the same privilege as triggering that job. A full-access-only job such as `system.ping` cannot be retried with `jobs:retry` alone. Full access still bypasses the trigger and retry checks. Policy gates from the access pipeline run before that bypass, so a later IP or schedule gate can still deny the action.

An idempotency key is stored as the caller, the job name, and the client key. Reuse by that caller returns the same row when the payload matches, and a different payload is rejected. Another caller does not see that row.

Payloads are stored as validated. Secret-like keys are rejected. Errors and logs are redacted, size-capped, and stored without stack traces. API reads and hook documents are redacted again for display and audit.

## Worker entry

OpenNext's generated `.open-next/worker.js` exports `fetch` only. `wrangler.jsonc` points `main` at `custom-worker.ts`. That file re-exports the OpenNext `fetch` handler. `queue` and `scheduled` call `openNextWorker.fetch` on `https://jobs.internal/jobs-worker` with the `JOBS_INTERNAL_SECRET` header. The route lives in the Next bundle, so Payload, Drizzle, and Lexical are not bundled a second time and `onInit` runs once. The route returns 404 unless the host is `jobs.internal` and the header matches the var. A public request stays 404 even when it sends the placeholder secret, including when it also sends `x-forwarded-host: jobs.internal`.

`pnpm build:worker` runs `next build --webpack` through OpenNext and must finish before Wrangler bundles the Worker, so `.open-next/worker.js` exists. `pnpm build` is only the Next.js build and does not produce that file. `custom-worker.ts` is part of `tsc`. The generated worker import uses `@ts-ignore` because that file is created by the worker build and is absent beforehand. The same build command inlines `.next/server/preview-props.json`, which Next 16 reads and OpenNext's manifest list does not include. Webpack does not emit Turbopack's hashed `drizzle-kit` require, so there is no esbuild stub. Workerd omits the Host header on a Request created inside the worker. OpenNext copied that missing header into `x-forwarded-host`, and Next then rewrote the host to the string `undefined`. The build fills `x-forwarded-host` from the request URL when the header is missing, so the route still sees `jobs.internal`.

`JOBS_INTERNAL_SECRET` is not a var in `wrangler.jsonc`. A var would block `wrangler secret put` under the same name, and the value would be committed. Set it with `wrangler secret put JOBS_INTERNAL_SECRET`. `.env.example` has a placeholder for local use only. In production the route refuses a secret that is missing, equal to that placeholder, or shorter than 32 characters. It logs that once and skips the run, so the cron does not throw every five minutes. A queue batch in that state is acknowledged and left `PENDING` for a later cron, instead of being retried until it hits the dead-letter queue. The comparison is constant-time. The host check remains the primary guard: a public request is 404 even with the right secret.

`pnpm build:worker` depends on `@opennextjs/cloudflare@1.20.10` (which depends on `@opennextjs/aws@4.1.9`). The host-header patch looks for one assignment in the generated OpenNext middleware. That string is not a public API. A bump can make the build throw or ship a Worker that 404s the internal route. Re-run `tests/int/jobs-worker-build.int.spec.ts` after changing it. The cron described above is active. The queue block stays commented until real queues exist.

## Local checks

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm exec vitest run --config ./vitest.config.mts --no-file-parallelism
pnpm build
```

`pnpm payload migrate:create --skip-empty` should not write a file after the jobs migration is committed.
