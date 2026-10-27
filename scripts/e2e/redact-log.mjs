// Redaction for the Worker log of the E2E run. CI prints that log and uploads it with the Playwright
// report, and artifacts and job logs of a public repository are public. Every value in a run is
// synthetic (a local database that is wiped on every start), but a token or password that ends up in
// a log is still a habit worth not having, so these rules mask what could be one.
//
// A rule is idempotent: running `redact` on its own output changes nothing, which is how
// `scripts/e2e/check-log-secrets.mjs` tells that a line was redacted.

/** The fixed `PAYLOAD_SECRET` the E2E Worker is started with. */
export const E2E_SECRET = 'e2e-worker-secret'

export const RULES = [
  {
    name: 'JWT',
    pattern: /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g,
    replace: '[jwt]',
  },
  {
    name: 'Authorization header',
    pattern: /("?authorization"?\s*[:=]\s*"?)[^"\n,}]+/gi,
    replace: '$1[redacted]',
  },
  {
    name: 'cookie',
    pattern: /("?(?:set-)?cookie"?\s*[:=]\s*"?)[^"\n]+/gi,
    replace: '$1[redacted]',
  },
  {
    name: 'secret or token field',
    pattern:
      /("?(?:password|hash|salt|secret|resetPasswordToken|reset_password_token|claimToken|claim_token|token)"?\s*[:=]\s*)"[^"]*"/gi,
    replace: '$1"[redacted]"',
  },
  {
    name: 'token in a URL',
    pattern: /([?&](?:token|reset_?password_?token|claim_?token)=)[^&\s"']+/gi,
    replace: '$1[redacted]',
  },
  {
    // The bound values of a failed query: they carry hashes, salts and reset or claim tokens, and
    // nothing in the list says which value is which.
    name: 'query parameters',
    pattern: /("params":\[)(?:"(?:[^"\\]|\\.)*"|[^\]"])*\]/g,
    replace: '$1"[redacted]"]',
  },
  {
    name: 'query parameters (text)',
    pattern: /(\bparams:\s*).*/g,
    replace: '$1[redacted]',
  },
  {
    name: 'reset link',
    pattern: /(\/reset\/)[0-9a-f]{16,}/gi,
    replace: '$1[hex]',
  },
  {
    name: 'long hex string',
    pattern: /\b[0-9a-f]{32,}\b/gi,
    replace: '[hex]',
  },
  {
    name: 'the E2E PAYLOAD_SECRET',
    pattern: /e2e-worker-secret/g,
    replace: '[secret]',
  },
]

/**
 * The rules for Playwright's traces and report. Those are full of 32 to 40 character hex ids that
 * are not secrets and that the viewer needs to find files (resource sha1 names, page ids), so the
 * blanket hex rule is left out; the reset link rule still masks a reset token in a URL.
 */
export const ARTIFACT_RULES = RULES.filter((rule) => rule.name !== 'long hex string')

export function redact(text, rules = RULES) {
  return rules.reduce((current, rule) => current.replace(rule.pattern, rule.replace), text)
}

/** Names of the rules that still change `text`, so empty means it is already redacted. */
export function unredactedRules(text, rules = RULES) {
  return rules
    .filter((rule) => text.replace(rule.pattern, rule.replace) !== text)
    .map((rule) => rule.name)
}
