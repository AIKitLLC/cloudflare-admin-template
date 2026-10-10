# Background jobs

Administrative work that does not fit in one HTTP request is a **job**. A job has a registered name, a JSON payload, a status, and timestamps. Operators watch those rows in the admin job monitor, and they can trigger a registered job or retry a failed one.

The statuses are `PENDING`, `RUNNING`, `SUCCESS`, and `FAILED`.

## What can run

Only names in the job registry run. `defineJob` registers a name, a payload validator, and an `execute` function. The admin UI and the API reject any other name. They do not accept a function, a file path, or a string of code.

`system.ping` is the only job shipped with the template. It records a short note. Jobs whose names start with `test.` can be registered from the test process. Production refuses those names.

A handler should be safe to run more than once. Queue delivery is at-least-once: a crash after the handler's side effect and before `SUCCESS` is written can run the handler again when the lease expires.

Do not put secrets in the payload. Keys whose names look like passwords, tokens, cookies, sessions, or API keys are stored as `[redacted]`. The handler reads the stored payload, so a retry sees the redacted value. Pass a record id and load the secret at execution time.

## Delivery

1. The jobs row is written in D1 first. That row is the source of truth.
2. In production, if the `JOB_QUEUE` binding exists, a message `{ jobId }` is sent to Cloudflare Queues.
3. Otherwise the inline runner processes the row in-process. `next dev` and Vitest use this path. Vitest does not auto-run jobs; tests call the runner directly.
4. If a production send throws, the same inline fallback runs so the row is not stranded.

The queue consumer and the cron both call the same claim function. A duplicate message, or a cron wake-up while a consumer is working, does not run the handler twice.

## Claim, lease, retry

A claim is one conditional `UPDATE`. It matches a `PENDING` row whose `runAt` is null or already due, or a `RUNNING` row whose lease has expired. A null `runAt` means the row is due immediately. The claim sets `RUNNING`, increments `attempt`, and stores a new `claimToken` and `leaseExpiresAt`. Two consumers cannot both match that statement.

The handler runs outside any database transaction. D1 does not keep a transaction open across the handler, and statements stay under the 100 bound-parameter limit. List queries are capped at 50 rows and page 20, and an `in` filter longer than 25 values is rejected.

While the handler runs it can extend the lease. If the lease expires, the scheduled reaper takes the row back: `PENDING` with backoff when attempts remain, or `FAILED` when `attempt` has reached `maxAttempts`. The default budget is 5 attempts. Backoff is `min(base * 2^(attempt-1), 15 minutes)` with a 1 second base.

A handler error uses the same budget. The last attempt is stored as `FAILED` with a capped error string. That row is the application dead letter. The queue's own dead-letter queue is a separate placeholder for messages the consumer never acknowledges.

Manual retry is allowed only from `FAILED`. It resets `attempt` to 0 and sets `PENDING`. `SUCCESS` and `RUNNING` cannot be retried.

Status changes from the worker are conditional updates. Collection `beforeChange` and `afterChange` hooks still run afterward, including hooks a later audit wrapper appends to the jobs collection. The hook call is not inside the claim statement, so a hook error is logged and does not roll the row back.

## Permissions

Default deny, same as the rest of the matrix.

| Key | What it allows |
| --- | --- |
| `jobs:read` | The job monitor and `GET /api/jobs` |
| `jobs:trigger` | Queue a registered job (`POST /api/jobs`, `POST /api/jobs/trigger`, GraphQL `createJob`) |
| `jobs:retry` | Re-queue a failed job (`POST /api/jobs/:id/retry`, GraphQL `retryJob`) |

`jobs:create`, `jobs:update`, `jobs:delete`, and `jobs:export` are not in the catalog. Job data fields carry their own read and create access, so they are not added as field permissions either. `jobs:read` sees the redacted payload, error, and logs. A trigger or retry caller also sees those fields on the document that mutation returns, and still cannot list jobs without `jobs:read`. `claimToken` stays hidden. Update and delete on the collection are closed, including for full access, so a client cannot rewrite status or delete history. Full access still bypasses the trigger and retry checks. Policy gates from the access pipeline run before that bypass, so a later IP or schedule gate can still deny the action.

Payloads, errors, and logs are redacted and size-capped on write and again on read.

## Worker entry

OpenNext's generated `.open-next/worker.js` exports `fetch` only. `wrangler.jsonc` points `main` at `custom-worker.ts`. That file re-exports the OpenNext `fetch` handler and adds:

- `queue`, which enters `runWithCloudflareRequestContext` from `.open-next/cloudflare/init.js` and then imports the queue handler. The context has to be set before Payload loads, because `src/payload.config.ts` reads the D1 binding from `getCloudflareContext`.
- `scheduled`, which uses the same context and runs the reaper plus a bounded wake-up of due `PENDING` rows.

`opennextjs-cloudflare build` must run before the Worker is bundled so `.open-next/worker.js` exists. `pnpm build` is only the Next.js build and does not produce that file.

`wrangler.jsonc` contains placeholder queue names (`placeholder-jobs`, `placeholder-jobs-dlq`) and a `*/5 * * * *` cron. Those resources are not created by this repository.

## Local checks

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm exec vitest run --config ./vitest.config.mts --no-file-parallelism
pnpm build
```

`pnpm payload migrate:create --skip-empty` should not write a file after the jobs migration is committed.
