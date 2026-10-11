import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(srcRoot, '../../..')

function specifiers(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    found.push(match[1])
  }
  for (const match of source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) {
    found.push(match[1])
  }
  return found
}

function resolveLocal(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec)
  if (existsSync(base) && (base.endsWith('.ts') || base.endsWith('.tsx'))) {
    return base
  }
  if (existsSync(`${base}.ts`)) return `${base}.ts`
  if (existsSync(`${base}.tsx`)) return `${base}.tsx`
  if (existsSync(join(base, 'index.ts'))) return join(base, 'index.ts')
  throw new Error(`Cannot resolve ${spec} from ${fromFile}`)
}

function walk(entry: string): { externals: Set<string>; files: Set<string> } {
  const externals = new Set<string>()
  const files = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()
    if (!file || files.has(file)) continue
    files.add(file)
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        queue.push(resolveLocal(file, spec))
        continue
      }
      if (!spec.startsWith('node:')) externals.add(spec)
    }
  }
  return { externals, files }
}

describe('@aikit/admin-jobs entries', () => {
  it('keeps the Payload entry off the Worker entry', () => {
    const graph = walk(join(srcRoot, 'index.ts'))
    const names = [...graph.files].map((file) => file.slice(srcRoot.length + 1))
    expect(names).not.toContain('worker.ts')
    expect(names).not.toContain('runtime/open-next-worker-types.ts')
  })

  it('keeps the Worker entry off Payload and the plugin', () => {
    const graph = walk(join(srcRoot, 'worker.ts'))
    const names = [...graph.files].map((file) => file.slice(srcRoot.length + 1))
    expect(names).not.toContain('plugin.ts')
    expect(names).not.toContain('index.ts')
    expect(names).not.toContain('collection/Jobs.ts')
    expect([...graph.externals].filter((spec) => spec === 'payload' || spec.startsWith('payload/') || spec === 'file-type' || spec.startsWith('@aikit/'))).toEqual([])
  })

  it('makes the outer Worker import the worker subpath', () => {
    const source = readFileSync(join(repoRoot, 'custom-worker.ts'), 'utf8')
    expect(source).toContain("from '@aikit/admin-jobs/worker'")
    expect(source).not.toMatch(/from '@aikit\/admin-jobs'/)
  })
})
