// Redacts what CI uploads when the E2E suite fails: the traces in `test-results/`, the HTML report
// in `playwright-report/` (its own copies of the traces and the report data embedded in
// `index.html`) and the text attachments next to them. Run it before the upload step; a second pass
// then checks that nothing the rules mask is left, and deletes the folders and fails if it is.
//
// A trace is a zip of JSON lines (`*.trace`, `*.network`), JSON (`*.stacks`) and response/request
// bodies under `resources/`, named after the SHA-1 of their content. A body that changes is
// renamed to the SHA-1 of its new content and every reference to it is rewritten, so the trace
// viewer still finds it. Images and stylesheets are left alone: a screenshot is not text.
//
// The zip is read and written with the `zipfile` module of `python3` (on every GitHub runner), so
// no dependency is added.
//
// Usage: node scripts/e2e/redact-artifacts.mjs [directory ...]   (default: test-results playwright-report)
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ARTIFACT_RULES, redact, unredactedRules } from './redact-log.mjs'

const TEXT_BODY = new Set(['.json', '.txt', '.html', '.htc', '.dat', '.xml', '.md', '.csv'])
const SHA1_KEY = /sha1/i
const SENSITIVE_NAME = /token|secret|password|authorization|cookie/i

function python(args, cwd) {
  const run = spawnSync('python3', ['-m', 'zipfile', ...args], { cwd, encoding: 'utf8' })
  if (run.status !== 0) {
    throw new Error(`python3 -m zipfile ${args[0]} failed: ${run.stderr || run.error?.message}`)
  }
}

function unzip(zipPath, directory) {
  mkdirSync(directory, { recursive: true })
  python(['-e', resolve(zipPath), directory])
}

function zip(zipPath, directory) {
  rmSync(zipPath, { force: true })
  python(['-c', resolve(zipPath), ...readdirSync(directory)], directory)
}

function filesUnder(directory) {
  const found = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) found.push(...filesUnder(path))
    else found.push(path)
  }
  return found
}

/**
 * Walks parsed JSON and redacts every string. `onChange` is called when something changed.
 * - a key that names a SHA-1 reference is kept (the viewer needs it);
 * - `{name, value}` pairs (headers, cookies) with a sensitive name lose the value;
 * - an action on a password field (`{selector, value}`) loses the typed value.
 */
export function redactJson(node, { references = new Map(), onChange = () => {} } = {}) {
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (key && SHA1_KEY.test(key)) return references.get(value) ?? value
      const clean = redact(value, ARTIFACT_RULES)
      if (clean !== value) onChange()
      return clean
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key))
    if (value && typeof value === 'object') {
      const hidden =
        typeof value.name === 'string' && SENSITIVE_NAME.test(value.name) && 'value' in value
          ? 'value'
          : typeof value.selector === 'string' &&
              /password/i.test(value.selector) &&
              'value' in value
            ? 'value'
            : null
      return Object.fromEntries(
        Object.entries(value).map(([name, child]) => {
          if (
            name === hidden &&
            typeof child === 'string' &&
            child !== '' &&
            child !== '[redacted]'
          ) {
            onChange()
            return [name, '[redacted]']
          }
          return [name, walk(child, name)]
        }),
      )
    }
    return value
  }
  return walk(node, undefined)
}

function redactJsonText(text, options) {
  let changed = false
  const onChange = () => {
    changed = true
  }
  const references = options?.references
  const handle = (line) => {
    if (line.trim() === '') return line
    try {
      const parsed = JSON.parse(line)
      let lineChanged = false
      const clean = redactJson(parsed, {
        references,
        onChange: () => {
          lineChanged = true
        },
      })
      if (references) {
        // A rewritten reference is a change too, even when no string was masked.
        if (JSON.stringify(clean) !== JSON.stringify(parsed)) lineChanged = true
      }
      if (!lineChanged) return line
      changed = true
      return JSON.stringify(clean)
    } catch {
      const clean = redact(line, ARTIFACT_RULES)
      if (clean !== line) onChange()
      return clean
    }
  }
  // Whole-file JSON (a single object, as `.stacks` and the report files are) or JSON lines.
  try {
    JSON.parse(text)
    return { text: handle(text), changed }
  } catch {
    return { text: text.split('\n').map(handle).join('\n'), changed }
  }
}

const sha1 = (buffer) => createHash('sha1').update(buffer).digest('hex')

/** Redacts the unpacked contents of one trace, in place. */
function redactTraceDirectory(directory) {
  const references = new Map()
  const resources = join(directory, 'resources')
  if (existsSync(resources)) {
    for (const name of readdirSync(resources)) {
      if (!TEXT_BODY.has(extname(name).toLowerCase())) continue
      const path = join(resources, name)
      const original = readFileSync(path, 'utf8')
      const { text: clean } = /\.json$/i.test(name)
        ? redactJsonText(original)
        : { text: redact(original, ARTIFACT_RULES) }
      if (clean === original) continue
      const renamed = `${sha1(Buffer.from(clean))}${extname(name)}`
      writeFileSync(path, clean)
      if (renamed !== name) renameSync(path, join(resources, renamed))
      references.set(name, renamed)
    }
  }
  for (const path of filesUnder(directory)) {
    if (!/\.(trace|network|stacks)$/.test(path)) continue
    const original = readFileSync(path, 'utf8')
    const { text, changed } = redactJsonText(original, { references })
    if (changed) writeFileSync(path, text)
  }
}

export function redactTraceZip(zipPath) {
  const directory = mkdtempSync(join(tmpdir(), 'trace-redact-'))
  try {
    unzip(zipPath, directory)
    redactTraceDirectory(directory)
    zip(zipPath, directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const EMBEDDED = /(data:application\/zip;base64,)([A-Za-z0-9+/=]+)/

/** The report data zip inside `index.html`: JSON files named after the test file, not their content. */
function redactReportHtml(path) {
  const html = readFileSync(path, 'utf8')
  const match = EMBEDDED.exec(html)
  if (!match) return
  const directory = mkdtempSync(join(tmpdir(), 'report-redact-'))
  try {
    const archive = join(directory, 'embedded.zip')
    writeFileSync(archive, Buffer.from(match[2], 'base64'))
    const unpacked = join(directory, 'unpacked')
    unzip(archive, unpacked)
    for (const file of filesUnder(unpacked)) {
      if (!file.endsWith('.json')) continue
      const { text, changed } = redactJsonText(readFileSync(file, 'utf8'))
      if (changed) writeFileSync(file, text)
    }
    zip(archive, unpacked)
    const encoded = readFileSync(archive).toString('base64')
    writeFileSync(
      path,
      html.replace(EMBEDDED, () => `${match[1]}${encoded}`),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Redacts every artifact under `directory`, in place. */
export function redactArtifacts(directory) {
  for (const path of filesUnder(directory)) {
    const name = basename(path)
    if (name.endsWith('.zip')) redactTraceZip(path)
    else if (name === 'index.html' && path.includes('playwright-report')) redactReportHtml(path)
    else if (/\.(md|txt)$/.test(name)) {
      const original = readFileSync(path, 'utf8')
      const clean = redact(original, ARTIFACT_RULES)
      if (clean !== original) writeFileSync(path, clean)
    }
  }
}

/** What would still be masked in `directory`, as `path: rule` strings. Never the matching text. */
export function leftovers(directory) {
  const found = new Set()
  const scanText = (label, text) => {
    for (const rule of unredactedRules(text, ARTIFACT_RULES)) found.add(`${label}: ${rule}`)
  }
  const scanTrace = (zipPath, label) => {
    const work = mkdtempSync(join(tmpdir(), 'trace-check-'))
    try {
      unzip(zipPath, work)
      for (const file of filesUnder(work)) {
        const ext = extname(file).toLowerCase()
        if (!/\.(trace|network|stacks)$/.test(file) && !TEXT_BODY.has(ext)) continue
        const text = readFileSync(file, 'utf8')
        // The references the viewer needs are skipped the same way as when redacting.
        if (/\.(trace|network|stacks)$/.test(file)) {
          const { changed } = redactJsonText(text)
          if (changed) found.add(`${label}!${file.slice(work.length + 1)}: masked content left`)
        } else if (/\.json$/i.test(file)) {
          if (redactJsonText(text).changed)
            found.add(`${label}!${file.slice(work.length + 1)}: masked content left`)
        } else {
          scanText(`${label}!${file.slice(work.length + 1)}`, text)
        }
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  for (const path of filesUnder(directory)) {
    const name = basename(path)
    if (name.endsWith('.zip')) scanTrace(path, path)
    else if (/\.(md|txt)$/.test(name)) scanText(path, readFileSync(path, 'utf8'))
    else if (name === 'index.html' && path.includes('playwright-report')) {
      const match = EMBEDDED.exec(readFileSync(path, 'utf8'))
      if (!match) continue
      const work = mkdtempSync(join(tmpdir(), 'report-check-'))
      try {
        const archive = join(work, 'embedded.zip')
        writeFileSync(archive, Buffer.from(match[2], 'base64'))
        unzip(archive, join(work, 'unpacked'))
        for (const file of filesUnder(join(work, 'unpacked'))) {
          if (file.endsWith('.json') && redactJsonText(readFileSync(file, 'utf8')).changed) {
            found.add(`${path}!embedded report: masked content left`)
          }
        }
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
    }
  }
  return [...found]
}

function main() {
  const directories =
    process.argv.length > 2 ? process.argv.slice(2) : ['test-results', 'playwright-report']
  let leaked = false
  for (const directory of directories.filter((candidate) => existsSync(candidate))) {
    try {
      redactArtifacts(directory)
      const left = leftovers(directory)
      if (left.length === 0) continue
      for (const entry of left.slice(0, 20)) console.error(`${entry}; ${directory} was removed`)
    } catch (error) {
      // An artifact that could not be redacted is not uploaded either.
      console.error(`${directory} could not be redacted and was removed: ${error.message}`)
    }
    leaked = true
    rmSync(directory, { recursive: true, force: true })
  }
  if (leaked) process.exit(1)
  console.log(`e2e: redacted ${directories.join(', ')}; nothing masked is left`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
