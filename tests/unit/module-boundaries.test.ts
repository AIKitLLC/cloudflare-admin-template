import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Enforces the in-code module boundaries (#45): every top-level `src/<m>` directory is a module
// whose only public surface is `src/<m>/index.ts`. There is no baseline: zero violations allowed.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const EXTRA_ENTRIES: Record<string, string[]> = {
  jobs: ['worker.ts'],
  auth: ['firebase.ts'],
  'client-security': ['client.ts'],
}
const PAYLOAD_CONFIG = 'src/payload.config.ts'
// Non-module groups: the composition root (payload.config.ts, src/config, src/migrations), the
// route layer, scripts and the worker entry.
const COMPOSITION = 'payload.config'
const ROUTE_LAYER = 'app'
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs']
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx']
const SKIPPED = new Set(['src/app/(payload)/admin/importMap.js', 'src/payload-types.ts'])

type Edge = {
  from: string
  fromGroup: string
  target: string
  targetGroup: string
  typeOnly: boolean
}

const toRel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/')

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function listSources(): string[] {
  const files = [
    ...walk(path.join(ROOT, 'src')).filter((f) => SOURCE_EXTENSIONS.includes(path.extname(f))),
    ...walk(path.join(ROOT, 'scripts')).filter((f) => ['.ts', '.mjs'].includes(path.extname(f))),
    path.join(ROOT, 'custom-worker.ts'),
  ]
  return files.filter((f) => existsSync(f) && !SKIPPED.has(toRel(f))).sort()
}

/** Group of a repo-relative file: a module name, the composition root, or a consumer group. */
function groupOf(rel: string): string {
  if (!rel.startsWith('src/')) return rel === 'custom-worker.ts' ? 'custom-worker' : 'scripts'
  const inSrc = rel.slice(4)
  const [first] = inSrc.split('/')
  if (!inSrc.includes('/') || first === 'config' || first === 'migrations') return COMPOSITION
  if (first === ROUTE_LAYER) return ROUTE_LAYER
  return first
}

const isModule = (group: string) =>
  group !== COMPOSITION && group !== ROUTE_LAYER && group !== 'scripts' && group !== 'custom-worker'

/**
 * Removes comments while leaving string, template and regex literals untouched, so a string such
 * as a glob ending in `*` + `/*` cannot open a fake block comment and hide the imports after it.
 */
function stripComments(text: string): string {
  let out = ''
  let i = 0
  // Whether a `/` here starts a regex literal rather than a division.
  const regexAllowed = () => {
    const before = out.trimEnd()
    return (
      before === '' ||
      '(,=:[!&|?{};+-*%<>~^'.includes(before.slice(-1)) ||
      /\b(?:return|typeof)$/.test(before)
    )
  }
  const skipQuoted = (quote: string) => {
    out += text[i++]
    while (i < text.length && text[i] !== quote && text[i] !== '\n') {
      if (text[i] === '\\') out += text[i++]
      out += text[i++]
    }
    if (i < text.length) out += text[i++]
  }
  const skipTemplate = () => {
    out += text[i++]
    while (i < text.length && text[i] !== '`') {
      if (text[i] === '\\') {
        out += text[i++]
      } else if (text[i] === '$' && text[i + 1] === '{') {
        out += text.slice(i, i + 2)
        i += 2
        let depth = 1
        while (i < text.length) {
          if (text[i] === '{') depth++
          else if (text[i] === '}' && --depth === 0) break
          scan()
        }
      }
      if (i < text.length) out += text[i++]
    }
    if (i < text.length) out += text[i++]
  }
  const skipRegex = () => {
    out += text[i++]
    let inClass = false
    while (i < text.length && text[i] !== '\n') {
      const ch = text[i]
      if (ch === '\\') out += text[i++]
      else if (ch === '[') inClass = true
      else if (ch === ']') inClass = false
      else if (ch === '/' && !inClass) break
      out += text[i++]
    }
    if (i < text.length && text[i] === '/') out += text[i++]
  }
  // Consumes one token of code, or one whole literal or comment.
  function scan() {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === "'" || ch === '"') skipQuoted(ch)
    else if (ch === '`') skipTemplate()
    else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, '')
      i = stop
    } else if (ch === '/' && regexAllowed()) skipRegex()
    else out += text[i++]
  }
  while (i < text.length) scan()
  return out
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string
  if (spec === '@payload-config') base = path.join(ROOT, PAYLOAD_CONFIG)
  else if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec)
  else return null
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix
    if (existsSync(candidate) && statSync(candidate).isFile()) return toRel(candidate)
  }
  return null
}

/** Module specifiers a source text imports, and whether it opens with a `'use client'` directive. */
function parseImports(source: string): {
  imports: { spec: string; typeOnly: boolean }[]
  useClient: boolean
} {
  const text = stripComments(source)
  const imports: { spec: string; typeOnly: boolean }[] = []
  // `import … from '…'` and `export … from '…'` (type-only when `import type` / `export type`).
  const fromPattern =
    /(?:^|[\s;{}])(?:import|export)(\s+type)?\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g
  for (const m of text.matchAll(fromPattern)) imports.push({ spec: m[2], typeOnly: Boolean(m[1]) })
  // Side-effect imports and dynamic imports.
  for (const m of text.matchAll(/(?:^|[\s;{}])import\s*['"]([^'"]+)['"]/g)) {
    imports.push({ spec: m[1], typeOnly: false })
  }
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports.push({ spec: m[1], typeOnly: false })
  }
  return { imports, useClient: /^\s*['"]use client['"]/.test(text) }
}

function readEdges(file: string): { edges: Edge[]; useClient: boolean } {
  const rel = toRel(file)
  const { imports, useClient } = parseImports(readFileSync(file, 'utf8'))
  const fromGroup = groupOf(rel)
  const edges: Edge[] = []
  for (const { spec, typeOnly } of imports) {
    const target = resolveSpecifier(file, spec)
    if (!target || !target.startsWith('src/')) continue
    edges.push({ from: rel, fromGroup, target, targetGroup: groupOf(target), typeOnly })
  }
  return { edges, useClient }
}

function isLegal(edge: Edge): boolean {
  const { fromGroup, targetGroup, target } = edge
  if (fromGroup === targetGroup) return true
  if (isModule(targetGroup)) {
    const entry = target.slice(`src/${targetGroup}/`.length)
    return entry === 'index.ts' || (EXTRA_ENTRIES[targetGroup] ?? []).includes(entry)
  }
  // Consumers (not modules) may import the composition root's payload.config.ts.
  return target === PAYLOAD_CONFIG && !isModule(fromGroup)
}

/** A `'use client'` file may import only its own module's internals, never any `index.ts`. */
function isUseClientViolation(edge: Edge): boolean {
  if (edge.typeOnly) return false
  return edge.fromGroup !== edge.targetGroup || /^src\/[^/]+\/index\.ts$/.test(edge.target)
}

/** Elementary cycles, each reported once: `a <-> b` for pairs, `a -> b -> c -> a` otherwise. */
function findCycles(graph: Map<string, Set<string>>): string[] {
  const found = new Set<string>()
  const visit = (start: string, node: string, trail: string[]) => {
    for (const next of [...(graph.get(node) ?? [])].sort()) {
      if (next === start) {
        found.add(trail.length === 2 ? trail.join(' <-> ') : [...trail, start].join(' -> '))
      } else if (next > start && !trail.includes(next)) {
        visit(start, next, [...trail, next])
      }
    }
  }
  for (const start of [...graph.keys()].sort()) visit(start, start, [start])
  return [...found].sort()
}

function analyse() {
  const all = listSources().map((file) => readEdges(file))
  const deepImports = new Set<string>()
  const graph = new Map<string, Set<string>>()
  const importedModules = new Set<string>()
  const useClientViolations = new Set<string>()
  const inGraph = (g: string) => isModule(g) || g === COMPOSITION
  for (const { edges, useClient } of all) {
    for (const edge of edges) {
      const entry = `${edge.from} -> ${edge.target}`
      const toNode = edge.target === PAYLOAD_CONFIG ? COMPOSITION : edge.targetGroup
      if (edge.fromGroup !== toNode && inGraph(edge.fromGroup) && inGraph(toNode)) {
        if (!graph.has(edge.fromGroup)) graph.set(edge.fromGroup, new Set())
        if (!graph.has(toNode)) graph.set(toNode, new Set())
        graph.get(edge.fromGroup)!.add(toNode)
      }
      if (edge.fromGroup !== edge.targetGroup && isModule(edge.targetGroup)) {
        importedModules.add(edge.targetGroup)
      }
      if (!isLegal(edge)) deepImports.add(entry)
      if (useClient && isUseClientViolation(edge)) useClientViolations.add(entry)
    }
  }
  return {
    cycles: findCycles(graph),
    deepImports: [...deepImports].sort(),
    importedModules,
    useClientViolations: [...useClientViolations].sort(),
  }
}

const NL = '\n'
const found = analyse()

test('no deep cross-module imports', () => {
  assert.deepEqual(
    found.deepImports,
    [],
    `Deep cross-module imports:${NL}${found.deepImports.join(NL)}`,
  )
})

test('module graph has no cycles', () => {
  assert.deepEqual(found.cycles, [], `Module cycles:${NL}${found.cycles.join(NL)}`)
})

test("'use client' files stay inside their module", () => {
  assert.deepEqual(
    found.useClientViolations,
    [],
    `'use client' files importing another group at runtime:${NL}${found.useClientViolations.join(NL)}`,
  )
})

test('every module directory with outside importers has an index.ts', () => {
  const missing = [...found.importedModules]
    .filter((m) => !existsSync(path.join(ROOT, 'src', m, 'index.ts')))
    .sort()
  assert.deepEqual(missing, [], `Missing index.ts in: ${missing.join(', ')}`)
})

test('admin component paths resolve', () => {
  const text = readFileSync(path.join(ROOT, PAYLOAD_CONFIG), 'utf8')
  const paths = [...text.matchAll(/['"`](@?\/[^#'"`]+#\w+)['"`]/g)]
    .map((m) => m[1])
    .filter((value) => /^@?\/[^#]+#\w+$/.test(value))
  assert.ok(paths.length > 0, 'no admin component paths found in payload.config.ts')
  const problems: string[] = []
  for (const value of paths) {
    const [rawPath, name] = value.split('#')
    const base = path.join(ROOT, 'src', rawPath.replace(/^@?\//, ''))
    const file = ['.tsx', '.ts'].map((ext) => base + ext).find((candidate) => existsSync(candidate))
    if (!file) {
      problems.push(`${value}: no file ${toRel(base)}.tsx or .ts`)
      continue
    }
    const source = readFileSync(file, 'utf8')
    const exported = [
      new RegExp(String.raw`export\s+(?:async\s+)?function\s+${name}\b`),
      new RegExp(String.raw`export\s+const\s+${name}\b`),
      new RegExp(String.raw`export\s*\{[^}]*\b${name}\b`),
    ].some((pattern) => pattern.test(source))
    if (!exported) problems.push(`${value}: ${toRel(file)} does not export ${name}`)
  }
  assert.deepEqual(problems, [], `Unresolved admin component paths:${NL}${problems.join(NL)}`)
})

test('comment stripping is string-aware', () => {
  const specs = (source: string) => parseImports(source).imports.map((i) => i.spec)
  // A glob string must not open a fake block comment that hides the import after it.
  const globThenImport = [
    "const glob = '**/*'",
    "import { x } from './after-glob'",
    '/** doc */',
  ].join('\n')
  assert.deepEqual(specs(globThenImport), ['./after-glob'])
  assert.deepEqual(specs('const t = `a /* ${"/*"} b`\nimport "./after-template"'), [
    './after-template',
  ])
  assert.deepEqual(specs("const re = /['\"`]/g\nimport { y } from './after-regex'"), [
    './after-regex',
  ])
  // Real comments are still removed, including imports written inside them.
  assert.deepEqual(specs("/* import a from './in-block' */\n// import b from './in-line'"), [])
  assert.deepEqual(specs("import a from './kept' // import b from './dropped'"), ['./kept'])
})

test("'use client' rule also rejects an import of the own module's index.ts", () => {
  const edge = (target: string, typeOnly = false): Edge => ({
    from: 'src/rbac/admin/View.tsx',
    fromGroup: 'rbac',
    target,
    targetGroup: 'rbac',
    typeOnly,
  })
  assert.equal(isUseClientViolation(edge('src/rbac/index.ts')), true)
  assert.equal(isUseClientViolation(edge('src/rbac/routes.ts')), false)
  assert.equal(isUseClientViolation(edge('src/rbac/index.ts', true)), false)
  assert.equal(isUseClientViolation({ ...edge('src/access/index.ts'), targetGroup: 'access' }), true)
})

const CLIENT_SAFE_ENTRIES = [
  'src/jobs/worker.ts',
  'src/auth/firebase.ts',
  'src/client-security/client.ts',
]
const FORBIDDEN_BARE = /^(?:payload(?:\/.*)?|@payloadcms\/.*|node:.*|next(?:\/.*)?)$/
const NODE_BUILTINS = new Set(builtinModules)

function isForbiddenBare(spec: string): boolean {
  return FORBIDDEN_BARE.test(spec) || NODE_BUILTINS.has(spec.split('/')[0])
}

test('forbidden bare specifiers cover Payload packages and unprefixed Node built-ins', () => {
  for (const spec of ['payload', 'payload/shared', 'next/headers', 'node:crypto']) {
    assert.equal(isForbiddenBare(spec), true, spec)
  }
  for (const spec of ['@payloadcms/ui', '@payloadcms/db-d1-sqlite', 'crypto', 'fs', 'fs/promises']) {
    assert.equal(isForbiddenBare(spec), true, spec)
  }
  for (const spec of ['jose', 'react', '@opennextjs/cloudflare', 'payloadish']) {
    assert.equal(isForbiddenBare(spec), false, spec)
  }
})

/** First forbidden thing reachable from `entry` (with the chain), or null. */
function forbiddenReach(entry: string): string | null {
  const seen = new Set<string>()
  const visit = (rel: string, chain: string[]): string | null => {
    if (seen.has(rel)) return null
    seen.add(rel)
    const file = path.join(ROOT, rel)
    const { imports } = parseImports(readFileSync(file, 'utf8'))
    for (const { spec } of imports) {
      if (isForbiddenBare(spec)) return [...chain, rel, `"${spec}"`].join(' -> ')
      const target = resolveSpecifier(file, spec)
      if (!target) continue
      const bad =
        target === PAYLOAD_CONFIG ||
        (/^src\/[^/]+\/index\.ts$/.test(target) && target !== rel)
      if (bad) return [...chain, rel, target].join(' -> ')
      if (target.startsWith('src/')) {
        const found = visit(target, [...chain, rel])
        if (found) return found
      }
    }
    return null
  }
  return visit(entry, [])
}

test('client-safe entries cannot reach server-only code', () => {
  const problems = CLIENT_SAFE_ENTRIES.map(forbiddenReach).filter((p): p is string => p !== null)
  assert.deepEqual(problems, [], `Client-safe entries reach server code:${NL}${problems.join(NL)}`)
})
