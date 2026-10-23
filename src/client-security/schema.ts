import { readFirebaseClientConfig } from '../auth/firebase'

/** Only public Firebase identifiers and bounded quota settings may be stored here. */
export interface ClientSecurityConfiguration {
  schemaVersion: 1
  firebase: {
    enabled: boolean
    projectId: string
    projectNumber: string
    appIds: string[]
  }
  limits: {
    windowSeconds: number
    uid: number
    ip: number
    global: number
  }
}

export class ClientSecurityValidationError extends Error {
  readonly status = 400
  readonly code = 'client_security_invalid_configuration'
  readonly reason = 'client_security_invalid_configuration'

  constructor() {
    super('client_security_invalid_configuration')
    this.name = 'ClientSecurityValidationError'
  }
}

function invalid(): never {
  throw new ClientSecurityValidationError()
}

function freezeConfiguration(config: ClientSecurityConfiguration): ClientSecurityConfiguration {
  Object.freeze(config.firebase.appIds)
  Object.freeze(config.firebase)
  Object.freeze(config.limits)
  return Object.freeze(config)
}

export const DEFAULT_CLIENT_SECURITY_CONFIGURATION: ClientSecurityConfiguration =
  freezeConfiguration({
    schemaVersion: 1,
    firebase: { enabled: false, projectId: '', projectNumber: '', appIds: [] },
    limits: { windowSeconds: 60, uid: 0, ip: 0, global: 0 },
  })

/** Snapshot own data properties without evaluating accessors or retaining caller objects. */
function strictRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  )
    invalid()

  const result: Record<string, unknown> = Object.create(null)
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid()
    result[key] = descriptor.value
  }
  return result
}

function appIdArray(value: unknown): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid()
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
  if (!Number.isInteger(length) || length < 0 || length > 20) invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== length + 1) invalid()
  const result: string[] = []
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.includes(',')
    )
      invalid()
    result.push(descriptor.value)
  }
  return result
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    invalid()
  return value
}

export function validateClientSecurityConfiguration(input: unknown): ClientSecurityConfiguration {
  try {
    const root = strictRecord(input, ['schemaVersion', 'firebase', 'limits'])
    const firebase = strictRecord(root.firebase, [
      'enabled',
      'projectId',
      'projectNumber',
      'appIds',
    ])
    const limits = strictRecord(root.limits, ['windowSeconds', 'uid', 'ip', 'global'])
    if (
      root.schemaVersion !== 1 ||
      typeof firebase.enabled !== 'boolean' ||
      typeof firebase.projectId !== 'string' ||
      typeof firebase.projectNumber !== 'string'
    )
      invalid()

    let appIds = appIdArray(firebase.appIds)
    const blank = firebase.projectId === '' && firebase.projectNumber === '' && appIds.length === 0
    if (firebase.enabled || !blank) {
      const config = readFirebaseClientConfig({
        FIREBASE_CLIENT_ENABLED: 'true',
        FIREBASE_PROJECT_ID: firebase.projectId,
        FIREBASE_PROJECT_NUMBER: firebase.projectNumber,
        FIREBASE_APP_IDS: appIds.join(','),
      })
      if (!config) invalid()
      appIds = [...config.appIds]
    }

    const config: ClientSecurityConfiguration = {
      schemaVersion: 1,
      firebase: {
        enabled: firebase.enabled,
        projectId: firebase.projectId,
        projectNumber: firebase.projectNumber,
        appIds,
      },
      limits: {
        windowSeconds: integer(limits.windowSeconds, 10, 3600),
        uid: integer(limits.uid, 0, 1_000_000),
        ip: integer(limits.ip, 0, 1_000_000),
        global: integer(limits.global, 0, 1_000_000),
      },
    }
    if (
      config.firebase.enabled &&
      [config.limits.uid, config.limits.ip, config.limits.global].includes(0)
    )
      invalid()
    return freezeConfiguration(config)
  } catch {
    // Invalid input, including throwing proxy traps, has one safe public error.
    return invalid()
  }
}

/** Explicit property order makes revisions independent of incoming JSON key order. */
export function canonicalClientSecurityConfiguration(config: ClientSecurityConfiguration): string {
  return JSON.stringify(validateClientSecurityConfiguration(config))
}

export async function digestClientSecurityConfiguration(
  config: ClientSecurityConfiguration,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalClientSecurityConfiguration(config))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function clientSecurityReadiness(config: ClientSecurityConfiguration): {
  ready: boolean
  reasons: string[]
} {
  try {
    const validated = validateClientSecurityConfiguration(config)
    const reasons: string[] = []
    if (!validated.firebase.enabled) reasons.push('firebase_client_disabled')
    if (!validated.firebase.projectId) reasons.push('firebase_project_id_missing')
    if (!validated.firebase.projectNumber) reasons.push('firebase_project_number_missing')
    if (!validated.firebase.appIds.length) reasons.push('firebase_app_ids_missing')
    for (const dimension of ['uid', 'ip', 'global'] as const)
      if (validated.limits[dimension] === 0)
        reasons.push(`client_security_${dimension}_limit_missing`)
    return { ready: reasons.length === 0, reasons }
  } catch {
    return { ready: false, reasons: ['client_security_invalid_configuration'] }
  }
}
