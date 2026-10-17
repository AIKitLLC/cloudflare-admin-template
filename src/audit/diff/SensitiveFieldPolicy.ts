/**
 * Strategy for deciding whether a field path may be written to the audit trail.
 * Default rules cover Payload auth material. Collections can add names.
 */
export interface FieldSensitivityRule {
  isSensitive(path: string): boolean
}

const SENSITIVE_LEAF_PATTERN =
  /(password|secret|token|api[-_]?key|credential|private[-_]?key|session|otp|one[-_]?time|pin|ssn|social[-_]?security|cvv|cvc|tax[-_]?id|national[-_]?id|passport|hash$|salt$)/i

/** Leaf names matched exactly, in addition to the pattern above. */
const SENSITIVE_LEAVES = new Set([
  'password',
  'hash',
  'salt',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'accessToken',
  'refreshToken',
  'session',
  'sessions',
  'resetPasswordToken',
  'authorization',
  'privateKey',
  'credential',
  'credentials',
  'otp',
  'pin',
  'ssn',
  'cvv',
  'cvc',
  'taxId',
  'tax_id',
  'nationalId',
  'national_id',
  'socialSecurityNumber',
  'passport',
])

export class PatternSensitivityRule implements FieldSensitivityRule {
  isSensitive(path: string): boolean {
    const leaf = leafName(path)
    return SENSITIVE_LEAVES.has(leaf) || SENSITIVE_LEAF_PATTERN.test(leaf)
  }
}

export class ExplicitFieldSensitivityRule implements FieldSensitivityRule {
  private readonly names: ReadonlySet<string>

  constructor(fieldNames: readonly string[]) {
    this.names = new Set(fieldNames)
  }

  isSensitive(path: string): boolean {
    return this.names.has(path) || this.names.has(leafName(path))
  }
}

/**
 * Composite policy. A path is sensitive when any rule matches.
 */
export class SensitiveFieldPolicy {
  constructor(private readonly rules: readonly FieldSensitivityRule[]) {}

  static fromExtraFields(extraFields: readonly string[] = []): SensitiveFieldPolicy {
    return new SensitiveFieldPolicy([
      new PatternSensitivityRule(),
      new ExplicitFieldSensitivityRule(extraFields),
    ])
  }

  isSensitive(path: string): boolean {
    if (!path) return false
    return this.rules.some((rule) => rule.isSensitive(path))
  }

  and(fieldNames: readonly string[]): SensitiveFieldPolicy {
    if (fieldNames.length === 0) return this
    return new SensitiveFieldPolicy([...this.rules, new ExplicitFieldSensitivityRule(fieldNames)])
  }
}

function leafName(path: string): string {
  const parts = path.split('.')
  return parts[parts.length - 1] ?? path
}
