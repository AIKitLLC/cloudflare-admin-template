import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { readFirebaseClientConfig } from '../../src/auth/firebase-client'
import {
  canonicalClientSecurityConfiguration,
  ClientSecurityValidationError,
  clientSecurityReadiness,
  DEFAULT_CLIENT_SECURITY_CONFIGURATION,
  digestClientSecurityConfiguration,
  type ClientSecurityConfiguration,
  validateClientSecurityConfiguration,
} from '../../src/client-security/schema'

// Deliberately synthetic public identifiers; never used to activate a real project.
function fixture(): ClientSecurityConfiguration {
  return {
    schemaVersion: 1,
    firebase: {
      enabled: true,
      projectId: 'template-fixture',
      projectNumber: '123456789',
      appIds: ['1:123456789:android:fixture', '1:123456789:ios:fixture'],
    },
    limits: { windowSeconds: 60, uid: 20, ip: 100, global: 1000 },
  }
}

function rejects(input: unknown): void {
  assert.throws(
    () => validateClientSecurityConfiguration(input),
    (error) => {
      assert.ok(error instanceof ClientSecurityValidationError)
      assert.equal(error.name, 'ClientSecurityValidationError')
      assert.equal(error.status, 400)
      assert.equal(error.code, 'client_security_invalid_configuration')
      assert.equal(error.reason, 'client_security_invalid_configuration')
      assert.equal(error.message, 'client_security_invalid_configuration')
      return true
    },
  )
}

test('defaults disable client access without guessing identifiers or enabling quotas', () => {
  assert.deepEqual(DEFAULT_CLIENT_SECURITY_CONFIGURATION, {
    schemaVersion: 1,
    firebase: { enabled: false, projectId: '', projectNumber: '', appIds: [] },
    limits: { windowSeconds: 60, uid: 0, ip: 0, global: 0 },
  })
  for (const value of [
    DEFAULT_CLIENT_SECURITY_CONFIGURATION,
    DEFAULT_CLIENT_SECURITY_CONFIGURATION.firebase,
    DEFAULT_CLIENT_SECURITY_CONFIGURATION.firebase.appIds,
    DEFAULT_CLIENT_SECURITY_CONFIGURATION.limits,
  ])
    assert.equal(Object.isFrozen(value), true)
  assert.deepEqual(
    validateClientSecurityConfiguration(DEFAULT_CLIENT_SECURITY_CONFIGURATION),
    DEFAULT_CLIENT_SECURITY_CONFIGURATION,
  )
  assert.deepEqual(clientSecurityReadiness(DEFAULT_CLIENT_SECURITY_CONFIGURATION), {
    ready: false,
    reasons: [
      'firebase_client_disabled',
      'firebase_project_id_missing',
      'firebase_project_number_missing',
      'firebase_app_ids_missing',
      'client_security_uid_limit_missing',
      'client_security_ip_limit_missing',
      'client_security_global_limit_missing',
    ],
  })
})

test('enabled configuration retains exact Firebase validator rules and snapshots caller data', () => {
  const input = fixture()
  const validated = validateClientSecurityConfiguration(input)
  assert.deepEqual(validated, input)
  assert.notEqual(validated, input)
  assert.notEqual(validated.firebase, input.firebase)
  assert.notEqual(validated.firebase.appIds, input.firebase.appIds)
  assert.notEqual(validated.limits, input.limits)
  input.firebase.appIds[0] = 'forged-after-validation'
  input.limits.global = 0
  assert.equal(validated.firebase.appIds[0], '1:123456789:android:fixture')
  assert.equal(validated.limits.global, 1000)
  assert.deepEqual(clientSecurityReadiness(validated), { ready: true, reasons: [] })
  assert.deepEqual(
    readFirebaseClientConfig({
      FIREBASE_CLIENT_ENABLED: 'true',
      FIREBASE_PROJECT_ID: validated.firebase.projectId,
      FIREBASE_PROJECT_NUMBER: validated.firebase.projectNumber,
      FIREBASE_APP_IDS: validated.firebase.appIds.join(','),
    }),
    {
      projectId: validated.firebase.projectId,
      projectNumber: validated.firebase.projectNumber,
      appIds: validated.firebase.appIds,
    },
  )
  assert.equal(Object.isFrozen(validated.firebase.appIds), true)
})

test('disabled configuration can retain a complete valid public identifier set and zero quotas', () => {
  const input = fixture()
  input.firebase.enabled = false
  input.limits.uid = 0
  input.limits.ip = 0
  input.limits.global = 0
  assert.deepEqual(validateClientSecurityConfiguration(input), input)
  assert.deepEqual(clientSecurityReadiness(input), {
    ready: false,
    reasons: [
      'firebase_client_disabled',
      'client_security_uid_limit_missing',
      'client_security_ip_limit_missing',
      'client_security_global_limit_missing',
    ],
  })
})

for (const enabled of [false, true]) {
  for (const [name, modify] of [
    [
      'missing project ID',
      (value: ClientSecurityConfiguration) => {
        value.firebase.projectId = ''
      },
    ],
    [
      'malformed project ID',
      (value: ClientSecurityConfiguration) => {
        value.firebase.projectId = 'INVALID ID'
      },
    ],
    [
      'missing project number',
      (value: ClientSecurityConfiguration) => {
        value.firebase.projectNumber = ''
      },
    ],
    [
      'zero project number',
      (value: ClientSecurityConfiguration) => {
        value.firebase.projectNumber = '0'
      },
    ],
    [
      'leading zero project number',
      (value: ClientSecurityConfiguration) => {
        value.firebase.projectNumber = '0123456789'
      },
    ],
    [
      'oversized project number',
      (value: ClientSecurityConfiguration) => {
        value.firebase.projectNumber = '1'.repeat(21)
      },
    ],
    [
      'missing app IDs',
      (value: ClientSecurityConfiguration) => {
        value.firebase.appIds = []
      },
    ],
    [
      'malformed app ID',
      (value: ClientSecurityConfiguration) => {
        value.firebase.appIds = ['token-canary']
      },
    ],
    [
      'wrong app project',
      (value: ClientSecurityConfiguration) => {
        value.firebase.appIds = ['1:987654321:android:fixture']
      },
    ],
    [
      'duplicate app IDs',
      (value: ClientSecurityConfiguration) => {
        value.firebase.appIds.push(value.firebase.appIds[0])
      },
    ],
    [
      'too many app IDs',
      (value: ClientSecurityConfiguration) => {
        value.firebase.appIds = Array.from(
          { length: 21 },
          (_, index) => `1:123456789:android:fixture${index}`,
        )
      },
    ],
    [
      'comma injection',
      (value: ClientSecurityConfiguration) => {
        value.firebase.appIds = ['1:123456789:android:fixture,1:123456789:ios:fixture']
      },
    ],
  ] as const) {
    test(`${enabled ? 'enabled' : 'disabled'} rejects ${name}`, () => {
      const input = fixture()
      input.firebase.enabled = enabled
      modify(input)
      rejects(input)
    })
  }
}

test('app ID whitespace uses the existing Firebase configuration normalization', () => {
  const input = fixture()
  input.firebase.appIds = [' 1:123456789:android:fixture ']
  assert.deepEqual(validateClientSecurityConfiguration(input).firebase.appIds, [
    '1:123456789:android:fixture',
  ])
})

test('quota bounds are inclusive and disabled quotas may be zero', () => {
  for (const windowSeconds of [10, 3600]) {
    const input = fixture()
    input.limits = { windowSeconds, uid: 1, ip: 1_000_000, global: 1_000_000 }
    assert.deepEqual(validateClientSecurityConfiguration(input), input)
  }
  for (const key of ['uid', 'ip', 'global'] as const) {
    const input = fixture()
    input.limits[key] = 0
    rejects(input)
    input.firebase.enabled = false
    assert.deepEqual(validateClientSecurityConfiguration(input), input)
  }
})

for (const key of ['windowSeconds', 'uid', 'ip', 'global'] as const) {
  test(`${key} rejects fractional, nonnumeric and out-of-range values`, () => {
    const minimum = key === 'windowSeconds' ? 10 : 0
    const maximum = key === 'windowSeconds' ? 3600 : 1_000_000
    for (const value of [
      minimum - 1,
      maximum + 1,
      10.5,
      NaN,
      Infinity,
      -Infinity,
      '60',
      null,
      true,
    ]) {
      const input = fixture()
      rejects({ ...input, limits: { ...input.limits, [key]: value } })
    }
  })
}

test('unknown fields are rejected at every object level, including secrets and nonenumerable fields', () => {
  for (const level of ['root', 'firebase', 'limits'] as const) {
    for (const key of ['accessToken', 'idToken', 'privateKey', '__proto__', 'description']) {
      const input = fixture()
      const target = level === 'root' ? input : input[level]
      Object.defineProperty(target, key, { value: 'token-canary', enumerable: true })
      rejects(input)
    }
    const input = fixture()
    const target = level === 'root' ? input : input[level]
    Object.defineProperty(target, 'hiddenSecret', { value: 'token-canary' })
    rejects(input)
    const symbolInput = fixture()
    const symbolTarget = level === 'root' ? symbolInput : symbolInput[level]
    Object.defineProperty(symbolTarget, Symbol('secret'), { value: 'token-canary' })
    rejects(symbolInput)
  }
})

test('missing fields, type coercion and nonplain objects are rejected', () => {
  for (const value of [
    null,
    undefined,
    [],
    new Date(),
    new Map(),
    true,
    'configuration',
    1,
  ] as unknown[])
    rejects(value)
  for (const key of ['schemaVersion', 'firebase', 'limits']) {
    const input: Record<string, unknown> = { ...fixture() }
    delete input[key]
    rejects(input)
  }
  for (const value of [0, 2, '1', null, true]) rejects({ ...fixture(), schemaVersion: value })
  for (const value of ['true', 1, null, undefined]) {
    const input = fixture()
    rejects({ ...input, firebase: { ...input.firebase, enabled: value } })
  }
  for (const key of ['firebase', 'limits'] as const) {
    for (const value of [[], null, new Date(), Object.create({ inherited: true })])
      rejects({ ...fixture(), [key]: value })
  }
  class Configuration {
    schemaVersion = 1
    firebase = fixture().firebase
    limits = fixture().limits
  }
  rejects(new Configuration())
})

test('null-prototype data objects remain valid JSON-shaped configuration', () => {
  const input = fixture()
  Object.setPrototypeOf(input, null)
  Object.setPrototypeOf(input.firebase, null)
  Object.setPrototypeOf(input.limits, null)
  assert.deepEqual(validateClientSecurityConfiguration(input), fixture())
})

test('accessors are rejected without executing code at all configuration levels', () => {
  let accessed = false
  for (const [level, key] of [
    ['root', 'schemaVersion'],
    ['firebase', 'projectId'],
    ['limits', 'uid'],
  ] as const) {
    const input = fixture()
    const target = level === 'root' ? input : input[level]
    Object.defineProperty(target, key, {
      enumerable: true,
      get() {
        accessed = true
        return 'token-canary'
      },
    })
    rejects(input)
  }
  const input = fixture()
  Object.defineProperty(input.firebase.appIds, '0', {
    enumerable: true,
    get() {
      accessed = true
      return 'token-canary'
    },
  })
  rejects(input)
  assert.equal(accessed, false)
})

test('app IDs reject sparse arrays, added properties, symbols, subclasses and nonstring values', () => {
  const sparse = new Array(1)
  const extra = ['1:123456789:android:fixture']
  Object.defineProperty(extra, 'idToken', { value: 'token-canary' })
  const symbols = ['1:123456789:android:fixture']
  Object.defineProperty(symbols, Symbol('secret'), { value: 'token-canary' })
  class AppIds extends Array<string> {}
  for (const appIds of [
    sparse,
    extra,
    symbols,
    new AppIds('1:123456789:android:fixture'),
    [''],
    [1],
    null,
    '1:123456789:android:fixture',
  ]) {
    const input = fixture()
    rejects({ ...input, firebase: { ...input.firebase, appIds } })
  }
})

test('throwing proxy traps produce a safe validation error', () => {
  const input = new Proxy(fixture(), {
    ownKeys() {
      throw new Error('token-canary')
    },
  })
  rejects(input)
})

test('canonical JSON uses explicit key order and remains independent of object insertion order', () => {
  const input = fixture()
  const reordered: ClientSecurityConfiguration = {
    limits: { global: 1000, ip: 100, uid: 20, windowSeconds: 60 },
    firebase: {
      appIds: input.firebase.appIds,
      projectNumber: '123456789',
      projectId: 'template-fixture',
      enabled: true,
    },
    schemaVersion: 1,
  }
  const expected =
    '{"schemaVersion":1,"firebase":{"enabled":true,"projectId":"template-fixture","projectNumber":"123456789","appIds":["1:123456789:android:fixture","1:123456789:ios:fixture"]},"limits":{"windowSeconds":60,"uid":20,"ip":100,"global":1000}}'
  assert.equal(canonicalClientSecurityConfiguration(input), expected)
  assert.equal(canonicalClientSecurityConfiguration(reordered), expected)
  assert.deepEqual(JSON.parse(expected), input)
})

test('revision digest is lowercase SHA-256 of canonical UTF-8 bytes and changes with security settings', async () => {
  const input = fixture()
  const digest = await digestClientSecurityConfiguration(input)
  assert.match(digest, /^[a-f0-9]{64}$/)
  assert.equal(
    digest,
    createHash('sha256').update(canonicalClientSecurityConfiguration(input), 'utf8').digest('hex'),
  )
  const modified = fixture()
  modified.limits.uid++
  assert.notEqual(await digestClientSecurityConfiguration(modified), digest)
  assert.equal(await digestClientSecurityConfiguration(JSON.parse(JSON.stringify(input))), digest)
  await assert.rejects(
    digestClientSecurityConfiguration({
      ...input,
      schemaVersion: 2,
    } as unknown as ClientSecurityConfiguration),
    ClientSecurityValidationError,
  )
})

test('readiness fails closed for malformed configuration, even if enabled is true', () => {
  const input = fixture()
  input.limits.global = 0
  assert.deepEqual(clientSecurityReadiness(input), {
    ready: false,
    reasons: ['client_security_invalid_configuration'],
  })
})
