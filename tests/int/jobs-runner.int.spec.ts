// @vitest-environment node
import { readFileSync } from 'fs'
import { createLocalReq, getPayload, type CollectionSlug, type Payload, type TypedUser } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { REDACTED } from '@/jobs/constants'
import { backoffMs } from '@/jobs/delivery/backoff'
import { deliverJob } from '@/jobs/delivery/deliver-job'
import { enqueueRegisteredJob } from '@/jobs/delivery/enqueue-registered-job'
import { errorDetails } from '@/jobs/redaction/cap-stored-text'
import { claimJob } from '@/jobs/persistence/claim-job'
import { d1 } from '@/jobs/persistence/d1-client'
import { reapExpiredLeases } from '@/jobs/persistence/reap-expired-leases'
import { readStoredJob } from '@/jobs/persistence/read-stored-job'
import { isSecretKey } from '@/jobs/redaction/secret-key'
import { redactSensitive } from '@/jobs/redaction/redact-sensitive'
import {
  decideInternalDispatch,
  logInternalSkipOnce,
  resetInternalSecretLogForTests,
  secretsMatch,
} from '@/jobs/runtime/internal-secret'
import { JOBS_INTERNAL_HOST, JOBS_WORKER_PATH } from '@/jobs/runtime/worker-dispatch'
import { defineJob } from '@/jobs/registry/define-job'
import { processQueueBatch } from '@/jobs/runner/process-queue-batch'
import { processJob } from '@/jobs/runner/process-job'
import { runScheduledMaintenance } from '@/jobs/runner/run-scheduled-maintenance'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/access/privilege/privilege-context'

let payload: Payload
let actor: TypedUser
const createdJobIds: Array<number | string> = []
let runs = 0
let releaseSlow = () => {}
let slowSignal: AbortSignal | undefined
let releaseRenew = () => {}
let renewSignal: AbortSignal | undefined
let cronRuns = 0

defineJob({
  name: 'test.counter',
  maxAttempts: 3,
  leaseMs: 60_000,
  backoffBaseMs: 5_000,
  validate(input: unknown) {
    return (input ?? {}) as { password?: string; note?: string }
  },
  async execute() {
    runs += 1
  },
})

defineJob({
  name: 'test.slow',
  maxAttempts: 3,
  leaseMs: 60_000,
  validate(input: unknown) {
    return input ?? {}
  },
  async execute(context) {
    slowSignal = context.signal
    await new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
  },
})

defineJob({
  name: 'test.renew',
  maxAttempts: 3,
  leaseMs: 900,
  validate(input: unknown) {
    return input ?? {}
  },
  async execute(context) {
    renewSignal = context.signal
    await new Promise<void>((resolve) => {
      releaseRenew = resolve
    })
  },
})

defineJob({
  name: 'test.cron',
  maxAttempts: 2,
  validate(input: unknown) {
    return input ?? {}
  },
  async execute() {
    cronRuns += 1
  },
})

defineJob({
  name: 'test.fail',
  maxAttempts: 3,
  backoffBaseMs: 5_000,
  leaseMs: 60_000,
  validate(input: unknown) {
    return input ?? {}
  },
  async execute() {
    runs += 1
    throw new Error('nope')
  },
})

describe('job runner', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    const role = await payload.find({
      collection: 'roles' as CollectionSlug,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { slug: { equals: 'super-admin' } },
    })
    if (!role.docs[0]) {
      throw new Error('super-admin role was not seeded')
    }
    const user = await payload.create({
      collection: 'users',
      data: {
        role: 'admin',
        email: `jobs-runner-${Date.now()}@example.com`,
        password: 'test-password-123',
        roles: [role.docs[0].id],
      },
      overrideAccess: true,
      context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
    })
    actor = user as TypedUser
  }, 120000)

  afterAll(async () => {
    if (!payload) return
    if (createdJobIds.length > 0) {
      await payload.delete({
        collection: 'jobs' as CollectionSlug,
        where: { id: { in: createdJobIds } },
        overrideAccess: true,
      })
    }
    if (actor) {
      await payload.delete({
        collection: 'users',
        where: { id: { equals: actor.id } },
        overrideAccess: true,
        context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
      })
    }
  }, 120000)

  it('redacts secret segments for display and leaves ordinary keys alone', () => {
    expect(redactSensitive({ password: 'hunter2', note: 'hi', nested: { api_key: 'k' } })).toEqual({
      password: REDACTED,
      note: 'hi',
      nested: { api_key: REDACTED },
    })
    expect(redactSensitive({ author: 'ada', passenger: 1, tokenCount: 2 })).toEqual({
      author: 'ada',
      passenger: 1,
      tokenCount: 2,
    })
    expect(isSecretKey('accessToken')).toBe(true)
    expect(isSecretKey('clientSecret')).toBe(true)
    expect(isSecretKey('dbPassword')).toBe(true)
    expect(isSecretKey('tokenCount')).toBe(false)
    expect(isSecretKey('author')).toBe(false)
    expect(redactSensitive({ accessToken: 'a', clientSecret: 'b', dbPassword: 'c', tokenCount: 2 })).toEqual({
      accessToken: REDACTED,
      clientSecret: REDACTED,
      dbPassword: REDACTED,
      tokenCount: 2,
    })
    const error = new Error('password=hunter2')
    error.stack = 'STACK SHOULD NOT BE STORED'
    const details = errorDetails(error)
    expect(details).toContain('[redacted]')
    expect(details).not.toContain('STACK')
    expect(details).not.toContain('hunter2')
    expect(backoffMs(1, 1000)).toBe(1000)
    expect(backoffMs(2, 1000)).toBe(2000)
    expect(backoffMs(3, 1000)).toBe(4000)
  })

  it('refuses secret-like payload keys and stores ordinary keys unchanged', async () => {
    await expect(makeJob('test.counter', { password: 'hunter2' })).rejects.toThrow(/secrets/i)
    await expect(makeJob('test.counter', { accessToken: 'a' })).rejects.toThrow(/secrets/i)
    await expect(makeJob('test.counter', { clientSecret: 'b' })).rejects.toThrow(/secrets/i)
    await expect(makeJob('test.counter', { dbPassword: 'c' })).rejects.toThrow(/secrets/i)
    const job = await makeJob('test.counter', { author: 'ada', passenger: 1, tokenCount: 2 })
    const stored = await readStoredJob(payload, job.id, { raw: true })
    expect(stored?.payload).toEqual({ author: 'ada', passenger: 1, tokenCount: 2 })
  })

  it('lets only one of two claims win', async () => {
    const job = await makeJob('test.counter', { note: 'claim' })
    const [first, second] = await Promise.all([
      claimJob(payload, job.id),
      claimJob(payload, job.id),
    ])
    const winners = [first, second].filter((result) => result !== null)
    expect(winners).toHaveLength(1)
    const stored = await readStoredJob(payload, job.id)
    expect(stored?.status).toBe('RUNNING')
    expect(stored?.attempt).toBe(1)
  })

  it('runs a duplicate delivery once', async () => {
    runs = 0
    const job = await makeJob('test.counter', { note: 'once' })
    const stored = await readStoredJob(payload, job.id, { raw: true })
    expect(stored?.payload).toEqual({ note: 'once' })

    const first = await processJob(payload, job.id)
    const second = await processJob(payload, job.id)
    expect(first.outcome).toBe('succeeded')
    expect(second.outcome).toBe('skipped')
    expect(runs).toBe(1)

    const messages = [queueMessage(Number(job.id)), queueMessage(Number(job.id))]
    await processQueueBatch(payload, { messages })
    expect(messages.every((message) => message.acked)).toBe(true)
    expect(runs).toBe(1)

    const invalid = {
      acked: false,
      retried: false,
      body: { jobId: 'abc' as unknown as number },
      ack() {
        this.acked = true
      },
      retry() {
        this.retried = true
      },
    }
    const logged: unknown[] = []
    const original = payload.logger.error.bind(payload.logger)
    payload.logger.error = ((entry: unknown) => {
      logged.push(entry)
      return original(entry)
    }) as typeof payload.logger.error
    try {
      await processQueueBatch(payload, { messages: [invalid] })
    } finally {
      payload.logger.error = original
    }
    expect(invalid.acked).toBe(true)
    expect(JSON.stringify(logged)).toContain('non-integer')
  })

  it('retries with backoff and then fails at the attempt limit', async () => {
    runs = 0
    const job = await makeJob('test.fail', {})
    const now = new Date('2026-01-01T00:00:00.000Z')
    const first = await processJob(payload, job.id, now)
    expect(first.outcome).toBe('retried')
    const afterFirst = await readStoredJob(payload, job.id)
    expect(afterFirst?.status).toBe('PENDING')
    expect(afterFirst?.attempt).toBe(1)
    expect(afterFirst?.runAt && afterFirst.runAt > now.toISOString()).toBe(true)
    expect(afterFirst?.error).toContain('nope')

    const early = await processJob(payload, job.id, now)
    expect(early.outcome).toBe('skipped')
    expect(runs).toBe(1)

    const second = await processJob(payload, job.id, new Date(now.getTime() + 5_000))
    expect(second.outcome).toBe('retried')
    expect(runs).toBe(2)

    const third = await processJob(payload, job.id, new Date(now.getTime() + 20_000))
    expect(third.outcome).toBe('failed')
    const dead = await readStoredJob(payload, job.id)
    expect(dead?.status).toBe('FAILED')
    expect(dead?.attempt).toBe(3)
    expect(runs).toBe(3)
  })

  it('reaps an expired lease once and lets the job run again', async () => {
    runs = 0
    const job = await makeJob('test.counter', { note: 'lease' })
    const now = new Date('2026-02-01T00:00:00.000Z')
    const claim = await claimJob(payload, job.id, now)
    expect(claim).not.toBeNull()
    await d1(payload)
      .prepare('UPDATE jobs SET lease_expires_at = ? WHERE id = ?')
      .bind(new Date(now.getTime() - 1000).toISOString(), job.id)
      .run()

    const [first, second] = await Promise.all([
      reapExpiredLeases(payload, now),
      reapExpiredLeases(payload, now),
    ])
    expect(first.requeued + second.requeued).toBe(1)
    const reaped = await readStoredJob(payload, job.id)
    expect(reaped?.status).toBe('PENDING')
    expect(reaped?.claimToken ?? null).toBeNull()

    const dueAt = new Date(now.getTime() + 60_000)
    const ran = await processJob(payload, job.id, dueAt)
    expect(ran.outcome).toBe('succeeded')
    expect(runs).toBe(1)
  })

  it('rejects the status write when a slow handler finishes after the reaper', async () => {
    const job = await makeJob('test.slow', { note: 'slow' })
    const running = processJob(payload, job.id)
    await waitFor(async () => (await readStoredJob(payload, job.id))?.status === 'RUNNING')
    const now = new Date()
    await d1(payload)
      .prepare('UPDATE jobs SET lease_expires_at = ? WHERE id = ?')
      .bind(new Date(now.getTime() - 1000).toISOString(), job.id)
      .run()
    const reaped = await reapExpiredLeases(payload, now)
    expect(reaped.requeued).toBe(1)
    releaseSlow()
    const result = await running
    expect(result.outcome).toBe('skipped')
    expect((await readStoredJob(payload, job.id))?.status).toBe('PENDING')
    expect(slowSignal?.aborted).toBe(false)
  })

  it('aborts the handler when lease renewal loses the claim', async () => {
    const job = await makeJob('test.renew', { note: 'renew' })
    const running = processJob(payload, job.id)
    await waitFor(async () => (await readStoredJob(payload, job.id))?.status === 'RUNNING')
    await d1(payload)
      .prepare('UPDATE jobs SET claim_token = ? WHERE id = ?')
      .bind('stolen', job.id)
      .run()
    await waitFor(() => renewSignal?.aborted === true, 2000)
    releaseRenew()
    const result = await running
    expect(result.outcome).toBe('skipped')
    expect((await readStoredJob(payload, job.id))?.status).toBe('RUNNING')
  })

  it('sends queue retries with delaySeconds', async () => {
    const sent: Array<{ options?: { delaySeconds?: number } }> = []
    await deliverJob(payload, 1, {
      delayMs: 5_000,
      queue: {
        async send(_message, options) {
          sent.push({ options })
        },
      },
    })
    expect(sent[0]?.options?.delaySeconds).toBe(5)
  })

  it('leaves a normal request alone while a scheduled run is in progress', async () => {
    const client = (payload.db as { client?: { prepare: (query: string) => unknown } }).client
    const originalPrepare = client?.prepare
    expect(originalPrepare).toBeTypeOf('function')
    slowSignal = undefined
    await d1(payload)
      .prepare("UPDATE jobs SET status = 'SUCCESS' WHERE status IN ('PENDING', 'RUNNING')")
      .run()
    const job = await makeJob('test.slow', { note: 'budget' })
    const first = runScheduledMaintenance(payload)
    const second = runScheduledMaintenance(payload)
    try {
      await waitFor(() => slowSignal !== undefined, 5000)
      expect(client?.prepare).toBe(originalPrepare)
      const users = await payload.find({
        collection: 'users',
        depth: 0,
        limit: 1,
        overrideAccess: true,
      })
      expect(users.docs.length).toBeGreaterThan(0)
      const ping = await d1(payload).prepare('SELECT 1 as ok').first<{ ok: number }>()
      expect(ping?.ok).toBe(1)
      expect(client?.prepare).toBe(originalPrepare)
    } finally {
      releaseSlow()
    }
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.ran + secondResult.ran).toBeGreaterThan(0)
    expect((await readStoredJob(payload, job.id))?.status).toBe('SUCCESS')
    expect(client?.prepare).toBe(originalPrepare)
  })

  it('skips a production jobs dispatch when the internal secret is unusable', () => {
    const longSecret = 'x'.repeat(32)
    const publicRequest = decideInternalDispatch({
      header: longSecret,
      hostname: 'admin.example.com',
      pathname: JOBS_WORKER_PATH,
      secret: longSecret,
      nodeEnv: 'production',
    })
    expect(publicRequest.action).toBe('not-found')

    const placeholder = decideInternalDispatch({
      header: 'placeholder-jobs-internal-secret',
      hostname: JOBS_INTERNAL_HOST,
      pathname: JOBS_WORKER_PATH,
      secret: 'placeholder-jobs-internal-secret',
      nodeEnv: 'production',
    })
    expect(placeholder.action).toBe('skip')

    const shortSecret = decideInternalDispatch({
      header: 'short-secret',
      hostname: JOBS_INTERNAL_HOST,
      pathname: JOBS_WORKER_PATH,
      secret: 'short-secret',
      nodeEnv: 'production',
    })
    expect(shortSecret.action).toBe('skip')

    const missing = decideInternalDispatch({
      header: longSecret,
      hostname: JOBS_INTERNAL_HOST,
      pathname: JOBS_WORKER_PATH,
      secret: undefined,
      nodeEnv: 'production',
    })
    expect(missing.action).toBe('skip')

    const allowed = decideInternalDispatch({
      header: longSecret,
      hostname: JOBS_INTERNAL_HOST,
      pathname: JOBS_WORKER_PATH,
      secret: longSecret,
      nodeEnv: 'production',
    })
    expect(allowed.action).toBe('allow')
    expect(secretsMatch(longSecret, longSecret)).toBe(true)
    expect(secretsMatch(longSecret, `${longSecret}x`)).toBe(false)

    resetInternalSecretLogForTests()
    const lines: string[] = []
    logInternalSkipOnce('missing', (message) => lines.push(message))
    logInternalSkipOnce('missing again', (message) => lines.push(message))
    expect(lines).toEqual(['Jobs worker skipped: missing'])
    resetInternalSecretLogForTests()
  })

  it('wakes a due job from the scheduled maintenance pass', async () => {
    cronRuns = 0
    await d1(payload)
      .prepare("UPDATE jobs SET status = 'SUCCESS' WHERE status IN ('PENDING', 'RUNNING')")
      .run()
    const job = await makeJob('test.cron', { note: 'cron' })
    const maintenance = await runScheduledMaintenance(payload, new Date())
    expect(maintenance.d1Calls).toBeLessThanOrEqual(40)
    expect(maintenance.ran).toBe(1)
    expect((await readStoredJob(payload, job.id))?.status).toBe('SUCCESS')
    expect(cronRuns).toBe(1)
  })

  it('keeps the worker entry and placeholder queue config', () => {
    const worker = readFileSync('custom-worker.ts', 'utf8')
    expect(worker).toContain('openNextWorker.fetch')
    expect(worker).toContain('buildWorkerRequest')
    expect(worker).toContain('async queue')
    expect(worker).toContain('async scheduled')
    expect(worker).not.toContain('payload.config')
    const wrangler = readFileSync('wrangler.jsonc', 'utf8')
    expect(wrangler).toContain('"main": "custom-worker.ts"')
    expect(wrangler).toContain('// "queues"')
    expect(wrangler).toContain('placeholder-jobs')
    expect(wrangler).toContain('placeholder-jobs-dlq')
    expect(wrangler).toContain('"crons": ["*/5 * * * *"]')
    expect(wrangler).toContain('wrangler secret put JOBS_INTERNAL_SECRET')
    expect(wrangler).not.toMatch(/"JOBS_INTERNAL_SECRET"\s*:/)
    expect(wrangler).not.toMatch(/^\s*"queues":/m)
  })
})

async function makeJob(name: string, body: unknown) {
  const req = await createLocalReq(
    {
      user: actor,
      context: { [SKIP_RBAC_PRIVILEGE_CHECKS]: true },
    },
    payload,
  )
  const result = await enqueueRegisteredJob({
    req,
    name,
    payload: body,
  })
  createdJobIds.push(result.job.id)
  return result.job
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for a job condition')
}

function queueMessage(jobId: number) {
  return {
    acked: false,
    retried: false,
    body: { jobId },
    ack() {
      this.acked = true
    },
    retry() {
      this.retried = true
    },
  }
}
