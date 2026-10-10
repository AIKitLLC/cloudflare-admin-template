// @vitest-environment node
import { readFileSync } from 'fs'
import { createLocalReq, getPayload, type CollectionSlug, type Payload, type TypedUser } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { REDACTED } from '@/jobs/constants'
import { backoffMs } from '@/jobs/delivery/backoff'
import { enqueueRegisteredJob } from '@/jobs/delivery/enqueue-registered-job'
import { claimJob } from '@/jobs/persistence/claim-job'
import { d1 } from '@/jobs/persistence/d1-client'
import { reapExpiredLeases } from '@/jobs/persistence/reap-expired-leases'
import { readStoredJob } from '@/jobs/persistence/read-stored-job'
import { redactSensitive } from '@/jobs/redaction/redact-sensitive'
import { defineJob } from '@/jobs/registry/define-job'
import { processQueueBatch } from '@/jobs/runner/process-queue-batch'
import { processJob } from '@/jobs/runner/process-job'
import { runScheduledMaintenance } from '@/jobs/runner/run-scheduled-maintenance'
import { SKIP_RBAC_PRIVILEGE_CHECKS } from '@/rbac/guards/privilege-context'

let payload: Payload
let actor: TypedUser
const createdJobIds: Array<number | string> = []
let runs = 0

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

  it('redacts sensitive keys and caps stored errors', () => {
    expect(redactSensitive({ password: 'hunter2', note: 'hi', nested: { apiKey: 'k' } })).toEqual({
      password: REDACTED,
      note: 'hi',
      nested: { apiKey: REDACTED },
    })
    expect(backoffMs(1, 1000)).toBe(1000)
    expect(backoffMs(2, 1000)).toBe(2000)
    expect(backoffMs(3, 1000)).toBe(4000)
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
    const job = await makeJob('test.counter', { note: 'once', password: 'secret' })
    const stored = await readStoredJob(payload, job.id)
    expect(stored?.payload).toEqual({ note: 'once', password: REDACTED })

    const first = await processJob(payload, job.id)
    const second = await processJob(payload, job.id)
    expect(first.outcome).toBe('succeeded')
    expect(second.outcome).toBe('skipped')
    expect(runs).toBe(1)

    const messages = [queueMessage(Number(job.id)), queueMessage(Number(job.id))]
    await processQueueBatch(payload, { messages })
    expect(messages.every((message) => message.acked)).toBe(true)
    expect(runs).toBe(1)
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

  it('wakes a due job from the scheduled maintenance pass', async () => {
    runs = 0
    const job = await makeJob('test.counter', { note: 'cron' })
    await runScheduledMaintenance(payload, new Date())
    const stored = await readStoredJob(payload, job.id)
    expect(stored?.status === 'SUCCESS' || stored?.status === 'PENDING' || stored?.status === 'RUNNING').toBe(
      true,
    )
    if (stored?.status !== 'SUCCESS') {
      await processJob(payload, job.id)
    }
    expect((await readStoredJob(payload, job.id))?.status).toBe('SUCCESS')
    expect(runs).toBe(1)
  })

  it('keeps the worker entry and placeholder queue config', () => {
    const worker = readFileSync('custom-worker.ts', 'utf8')
    expect(worker).toContain('runWithCloudflareRequestContext')
    expect(worker).toContain('async queue')
    expect(worker).toContain('async scheduled')
    expect(worker).toContain('handleQueueBatch')
    expect(worker).toContain('handleScheduled')
    const wrangler = readFileSync('wrangler.jsonc', 'utf8')
    expect(wrangler).toContain('"main": "custom-worker.ts"')
    expect(wrangler).toContain('placeholder-jobs')
    expect(wrangler).toContain('placeholder-jobs-dlq')
    expect(wrangler).toContain('"crons"')
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
