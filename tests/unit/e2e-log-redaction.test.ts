import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { redact, unredactedRules } from '../../scripts/e2e/redact-log.mjs'

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiY29sbGVjdGlvbiI6InVzZXJzIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU'
const HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'

const SECRETS = [
  `GET /api/users/me authorization: JWT ${JWT}`,
  `{"headers":{"authorization":"JWT ${JWT}","cookie":"payload-token=${JWT}; other=1"}}`,
  `set-cookie: payload-token=${JWT}; Path=/; HttpOnly; Secure`,
  `POST /admin/reset/${HEX}?token=${HEX} 200`,
  `{"resetPasswordToken":"${HEX}","claimToken":"abc","password":"hunter2-hunter2"}`,
  `Failed query: insert into "users" ("hash","salt") values (?, ?)\nparams: ${HEX},cafebabe`,
  `{"query":"insert","params":["${HEX}","salt with ] bracket",3,null]}`,
  'wrangler dev --var PAYLOAD_SECRET:e2e-worker-secret',
]

test('every secret shape is masked and nothing of its value survives', () => {
  for (const line of SECRETS) {
    const clean = redact(line)
    assert.notEqual(clean, line, line)
    for (const value of [JWT, HEX, 'hunter2', 'e2e-worker-secret', 'salt with']) {
      assert.ok(!clean.includes(value), `${value} survived in: ${clean}`)
    }
  }
})

test('redaction is idempotent and leaves ordinary lines alone', () => {
  for (const line of SECRETS) {
    const once = redact(line)
    assert.equal(redact(once), once)
    assert.deepEqual(unredactedRules(once), [])
  }
  const plain = [
    '[wrangler:info] GET /api/users/me 200 OK (7ms)',
    '{"level":"error","msg":"Audit log write failed for DELETE users #63"}',
    'e2e: migrated the local D1 (main)',
  ]
  for (const line of plain) assert.equal(redact(line), line)
})

test('the check removes a leaking log, names the rule and fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'e2e-log-check-'))
  try {
    writeFileSync(join(directory, 'worker.log'), 'fine\n[wrangler:info] ok\n')
    writeFileSync(join(directory, 'worker-interrupted.log'), `fine\nauthorization: JWT ${JWT}\n`)
    const run = spawnSync(process.execPath, ['scripts/e2e/check-log-secrets.mjs', directory], {
      encoding: 'utf8',
    })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /worker-interrupted\.log: .*line\(s\) 2/)
    assert.ok(!run.stderr.includes(JWT) && !run.stdout.includes(JWT))
    assert.ok(!existsSync(join(directory, 'worker-interrupted.log')))
    assert.equal(readFileSync(join(directory, 'worker.log'), 'utf8'), 'fine\n[wrangler:info] ok\n')

    const clean = spawnSync(process.execPath, ['scripts/e2e/check-log-secrets.mjs', directory], {
      encoding: 'utf8',
    })
    assert.equal(clean.status, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
