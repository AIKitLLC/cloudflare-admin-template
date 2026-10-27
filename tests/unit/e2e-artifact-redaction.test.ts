import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'

import {
  leftovers,
  redactArtifacts,
  redactJson,
  redactTraceZip,
} from '../../scripts/e2e/redact-artifacts.mjs'

const hasPython = spawnSync('python3', ['--version']).status === 0
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiY29sbGVjdGlvbiI6InVzZXJzIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU'
const RESET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'
const sha1 = (text: string | Buffer) => createHash('sha1').update(text).digest('hex')

/** Writes `files` into a zip with python3's zipfile, the tool the redaction itself uses. */
function makeZip(zipPath: string, files: Record<string, string | Buffer>) {
  const source = mkdtempSync(join(tmpdir(), 'trace-src-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(source, name)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, content)
    }
    const run = spawnSync('python3', ['-m', 'zipfile', '-c', zipPath, ...readdirSync(source)], {
      cwd: source,
    })
    assert.equal(run.status, 0, String(run.stderr))
  } finally {
    rmSync(source, { recursive: true, force: true })
  }
}

function readZip(zipPath: string): Map<string, Buffer> {
  const target = mkdtempSync(join(tmpdir(), 'trace-out-'))
  try {
    const run = spawnSync('python3', ['-m', 'zipfile', '-e', zipPath, target])
    assert.equal(run.status, 0, String(run.stderr))
    const entries = new Map<string, Buffer>()
    for (const name of readdirSync(target, { recursive: true, encoding: 'utf8' })) {
      const path = join(target, name)
      if (statSync(path).isFile()) entries.set(name.split(sep).join('/'), readFileSync(path))
    }
    return entries
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
}

const loginBody = JSON.stringify({ token: JWT, user: { email: 'a@example.com' } })
const loginName = `${sha1(loginBody)}.json`
const plainBody = JSON.stringify({ docs: [], totalDocs: 0 })
const plainName = `${sha1(plainBody)}.json`
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])
const pngName = `${sha1(png)}.png`

function trace() {
  const network = [
    {
      type: 'resource-snapshot',
      snapshot: {
        request: {
          url: `http://localhost:8792/admin/reset/${RESET}`,
          headers: [
            { name: 'Authorization', value: `JWT ${JWT}` },
            { name: 'accept', value: 'application/json' },
          ],
          cookies: [{ name: 'payload-token', value: JWT }],
        },
        response: {
          content: { _sha1: loginName },
          headers: [{ name: 'set-cookie', value: `payload-token=${JWT}` }],
        },
      },
    },
    { type: 'resource-snapshot', snapshot: { response: { content: { _sha1: plainName } } } },
  ]
  const actions = [
    { type: 'before', params: { selector: '#field-password', value: 'hunter2-hunter2' } },
    { type: 'screencast-frame', sha1: pngName },
  ]
  return {
    '1-trace.network': network.map((line) => JSON.stringify(line)).join('\n'),
    '1-trace.trace': actions.map((line) => JSON.stringify(line)).join('\n'),
    [`resources/${loginName}`]: loginBody,
    [`resources/${plainName}`]: plainBody,
    [`resources/${pngName}`]: png,
  }
}

test('redactJson masks sensitive pairs and keeps SHA-1 references', () => {
  let changed = false
  const clean = redactJson(
    {
      headers: [{ name: 'Cookie', value: `payload-token=${JWT}` }],
      params: { selector: 'input[type=password]', value: 'hunter2' },
      _sha1: RESET,
      note: `see /admin/reset/${RESET}`,
    },
    {
      onChange: () => {
        changed = true
      },
    },
  )
  assert.equal(changed, true)
  assert.deepEqual(clean.headers, [{ name: 'Cookie', value: '[redacted]' }])
  assert.equal(clean.params.value, '[redacted]')
  assert.equal(clean._sha1, RESET)
  assert.equal(clean.note, 'see /admin/reset/[hex]')
})

test(
  'a trace is redacted, its renamed bodies stay referenced and untouched ones stay as they are',
  { skip: !hasPython },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'artifact-test-'))
    try {
      const zipPath = join(directory, 'trace.zip')
      makeZip(zipPath, trace())
      assert.ok(leftovers(directory).length > 0, 'the fixture must contain something to mask')

      redactTraceZip(zipPath)

      const entries = readZip(zipPath)
      for (const secret of [JWT, RESET, 'hunter2']) {
        const where = [...entries]
          .filter(
            ([name, buffer]) => !name.endsWith('.png') && buffer.toString('utf8').includes(secret),
          )
          .map(([name]) => name)
        assert.deepEqual(where, [], secret)
      }

      const network = entries.get('1-trace.network')!.toString('utf8')
      const references = [...network.matchAll(/"_sha1":"([^"]+)"/g)].map((match) => match[1])
      assert.equal(references.length, 2)
      for (const name of references) {
        const body = entries.get(`resources/${name}`)
        assert.ok(body, `${name} is in the trace`)
        assert.equal(sha1(body), name.replace(/\.json$/, ''), 'a body is named after its content')
      }
      assert.ok(!references.includes(loginName), 'the login body was renamed')
      assert.ok(references.includes(plainName), 'an unchanged body keeps its name')
      assert.deepEqual(entries.get(`resources/${pngName}`), png)
      assert.match(entries.get('1-trace.trace')!.toString('utf8'), new RegExp(pngName))
      assert.deepEqual(leftovers(directory), [])

      // Running it again changes nothing.
      const before = readZip(zipPath)
      redactTraceZip(zipPath)
      const after = readZip(zipPath)
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort())
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'the command removes an artifact folder it cannot redact and fails',
  { skip: !hasPython },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'artifact-cli-'))
    try {
      const results = join(directory, 'results')
      mkdirSync(results)
      writeFileSync(join(results, 'trace.zip'), 'this is not a zip file')
      const run = spawnSync(process.execPath, ['scripts/e2e/redact-artifacts.mjs', results], {
        encoding: 'utf8',
      })
      assert.equal(run.status, 1)
      assert.match(run.stderr, /could not be redacted and was removed/)
      assert.ok(!existsSync(results))

      const clean = join(directory, 'clean')
      mkdirSync(clean)
      writeFileSync(join(clean, 'notes.txt'), `token in a note: payload-token=${JWT}`)
      const ok = spawnSync(process.execPath, ['scripts/e2e/redact-artifacts.mjs', clean], {
        encoding: 'utf8',
      })
      assert.equal(ok.status, 0, ok.stderr)
      assert.ok(!readFileSync(join(clean, 'notes.txt'), 'utf8').includes(JWT))
      redactArtifacts(clean)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
