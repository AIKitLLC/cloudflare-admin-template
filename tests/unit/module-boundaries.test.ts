import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Enforces the in-code module boundaries (#45): every top-level `src/<m>` directory is a module
// whose only public surface is `src/<m>/index.ts`. Existing violations live in the baseline JSON,
// which later tasks shrink until it is empty. `UPDATE_BASELINE=1` rewrites the baseline.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BASELINE_PATH = path.join(ROOT, 'tests/unit/module-boundaries.baseline.json')
const EXTRA_ENTRIES: Record<string, string[]> = { jobs: ['worker.ts'] }
const PAYLOAD_CONFIG = 'src/payload.config.ts'
// Non-module groups: the composition root (payload.config.ts, src/config, src/migrations), the
// route layer, scripts and the worker entry.
const COMPOSITION = 'payload.config'
const ROUTE_LAYER = 'app'
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs']
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx']
const SKIPPED = new Set(['src/app/(payload)/admin/importMap.js', 'src/payload-types.ts'])

type Baseline = { cycles: string[]; deepImports: string[] }
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

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
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

function readEdges(file: string): { edges: Edge[]; useClient: boolean } {
  const rel = toRel(file)
  const text = stripComments(readFileSync(file, 'utf8'))
  const fromGroup = groupOf(rel)
  const edges: Edge[] = []
  const add = (spec: string, typeOnly: boolean) => {
    const target = resolveSpecifier(file, spec)
    if (!target || !target.startsWith('src/')) return
    edges.push({ from: rel, fromGroup, target, targetGroup: groupOf(target), typeOnly })
  }
  // `import … from '…'` and `export … from '…'` (type-only when `import type` / `export type`).
  const fromPattern =
    /(?:^|[\s;{}])(?:import|export)(\s+type)?\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g
  for (const m of text.matchAll(fromPattern)) add(m[2], Boolean(m[1]))
  // Side-effect imports and dynamic imports.
  for (const m of text.matchAll(/(?:^|[\s;{}])import\s*['"]([^'"]+)['"]/g)) add(m[1], false)
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1], false)
  return { edges, useClient: /^\s*['"]use client['"]/.test(text) }
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
      if (useClient && !edge.typeOnly && edge.fromGroup !== edge.targetGroup) {
        useClientViolations.add(entry)
      }
    }
  }
  return {
    cycles: findCycles(graph),
    deepImports: [...deepImports].sort(),
    importedModules,
    useClientViolations: [...useClientViolations].sort(),
  }
}

const found = analyse()

if (process.env.UPDATE_BASELINE === '1') {
  const next: Baseline = { cycles: found.cycles, deepImports: found.deepImports }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline

test('no deep cross-module imports outside the baseline', () => {
  const known = new Set(baseline.deepImports)
  const offenders = found.deepImports.filter((entry) => !known.has(entry))
  assert.deepEqual(offenders, [], `New deep cross-module imports:\n${offenders.join('\n')}`)
})

test('baseline has no stale deep imports', () => {
  const current = new Set(found.deepImports)
  const stale = baseline.deepImports.filter((entry) => !current.has(entry))
  assert.deepEqual(stale, [], `Remove from the baseline:\n${stale.join('\n')}`)
})

test('module graph cycles match the baseline', () => {
  assert.deepEqual(found.cycles, [...baseline.cycles].sort())
})

test("'use client' files stay inside their module", () => {
  assert.deepEqual(found.useClientViolations, [])
})

test('every module directory with outside importers has an index.ts', () => {
  const stillBaselined = (m: string) =>
    baseline.deepImports.some((entry) => entry.split(' -> ')[1]?.startsWith(`src/${m}/`))
  const missing = [...found.importedModules]
    .filter((m) => !stillBaselined(m) && !existsSync(path.join(ROOT, 'src', m, 'index.ts')))
    .sort()
  assert.deepEqual(missing, [], `Missing index.ts in: ${missing.join(', ')}`)
})
