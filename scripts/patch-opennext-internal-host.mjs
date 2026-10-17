import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FALLBACK = ' || new URL(result.internalEvent.url).host'
const NEEDLES = [
  '"x-forwarded-host": result.internalEvent.headers.host',
  '"x-forwarded-host":result.internalEvent.headers.host',
]

/**
 * Workerd does not expose a Host header on a Request built inside the worker.
 * OpenNext's edge converter then sets x-forwarded-host from that missing header,
 * and the Headers constructor turns the missing value into the string "undefined".
 * Next copies x-forwarded-host onto host, so the jobs route sees
 * https://undefined/jobs-worker and rejects the dispatch.
 * Fill x-forwarded-host from the request URL when the header was not copied.
 */
export function patchOpenNextInternalHost(root = join(process.cwd(), '.open-next')) {
  const files = collectMjs(root)
  let total = 0
  for (const file of files) {
    const original = readFileSync(file, 'utf8')
    const { text, count } = patchText(original)
    total += count
    if (count > 0) writeFileSync(file, text)
  }
  const middleware = join(root, 'middleware/handler.mjs')
  const middlewareText = readFileSync(middleware, 'utf8')
  if (!middlewareText.includes(`headers.host${FALLBACK}`)) {
    throw new Error(
      `OpenNext middleware did not contain the x-forwarded-host assignment at ${middleware}`,
    )
  }
  if (total < 1) {
    throw new Error('OpenNext internal host patch did not change any files')
  }
}

function patchText(text) {
  let count = 0
  for (const needle of NEEDLES) {
    let index = 0
    while ((index = text.indexOf(needle, index)) !== -1) {
      const after = text.slice(index + needle.length, index + needle.length + FALLBACK.length)
      if (after.startsWith(FALLBACK)) {
        index += needle.length
        continue
      }
      text = text.slice(0, index + needle.length) + FALLBACK + text.slice(index + needle.length)
      count += 1
      index += needle.length + FALLBACK.length
    }
  }
  return { text, count }
}

function collectMjs(dir) {
  const found = []
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      found.push(...collectMjs(path))
      continue
    }
    if (entry.endsWith('.mjs')) found.push(path)
  }
  return found
}
