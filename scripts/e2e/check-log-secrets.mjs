// Fails when a Worker log still holds something `redact-log.mjs` would mask, and removes that log so
// the artifact upload that follows cannot publish it. Prints the rule names and line numbers, never
// the matching text.
//
// Usage: node scripts/e2e/check-log-secrets.mjs [directory]   (default: .wrangler/e2e-logs)
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { unredactedRules } from './redact-log.mjs'

const directory = process.argv[2] ?? join('.wrangler', 'e2e-logs')
let leaked = false

if (existsSync(directory)) {
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.log'))) {
    const path = join(directory, name)
    const found = new Map()
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const rule of unredactedRules(line)) {
          found.set(rule, [...(found.get(rule) ?? []), index + 1])
        }
      })
    if (found.size === 0) continue
    leaked = true
    rmSync(path)
    for (const [rule, lines] of found) {
      console.error(
        `${path}: ${rule} on line(s) ${lines.slice(0, 10).join(', ')}; the log was removed`,
      )
    }
  }
}

if (leaked) process.exit(1)
console.log(`e2e: no unredacted secrets in ${directory}`)
