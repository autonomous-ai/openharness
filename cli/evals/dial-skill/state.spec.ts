import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { caseId, loadScenarios } from './lib/scenarios.js'

const evalDir = dirname(fileURLToPath(import.meta.url))
// harness_paths are relative to cli/, the directory the runner is run from.
const cliDir = join(evalDir, '..', '..')
const state = JSON.parse(readFileSync(join(evalDir, 'flow', '_state.json'), 'utf8')) as {
  train_ids: string[]
  val_ids: string[]
  test_ids: string[]
  metrics: { id: string; kind: string }[]
  harness_paths: string[]
}
const splits = { train: state.train_ids, val: state.val_ids, test: state.test_ids }

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

// Every eval file the runner loads, followed through relative imports; a .js specifier names its .ts source.
function runnerImports(file: string, seen = new Set<string>()): Set<string> {
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(/from\s+'(\.[^']+)'/g)) {
    let path = join(dirname(file), spec)
    if (!existsSync(path)) path = path.replace(/\.js$/, '.ts')
    if (!path.startsWith(evalDir) || seen.has(path)) continue
    seen.add(path)
    runnerImports(path, seen)
  }
  return seen
}

describe('flow/_state.json', () => {
  it('puts every Claude case in exactly one split, and no Codex case', () => {
    const all = Object.values(splits).flat()
    for (const scenario of loadScenarios()) {
      expect(all.filter((id) => id === caseId(scenario.id, 'claude'))).toHaveLength(1)
    }
    expect(all.filter((id) => id.endsWith('.codex'))).toEqual([])
    expect(all).toHaveLength(loadScenarios().length)
  })

  it('splits need and no-need cases 4/2, 3/2, 3/2', () => {
    const need = new Map(loadScenarios().map((s) => [caseId(s.id, 'claude'), s.need]))
    const counts = Object.fromEntries(
      Object.entries(splits).map(([name, ids]) => [
        name,
        [ids.filter((id) => need.get(id) === 'need').length, ids.filter((id) => need.get(id) === 'no-need').length],
      ]),
    )
    expect(counts).toEqual({ train: [4, 2], val: [3, 2], test: [3, 2] })
  })

  it('headlines score and declares no binary metric', () => {
    expect(state.metrics[0].id).toBe('score')
    expect(state.metrics.filter((m) => m.kind === 'binary')).toEqual([])
  })

  it('lists every scenario file and every lib file the runner imports, and never the skill', () => {
    for (const path of state.harness_paths) expect(existsSync(join(cliDir, path)), path).toBe(true)
    const listed = new Set(state.harness_paths)
    const required = [
      ...filesUnder(join(evalDir, 'scenarios')),
      ...runnerImports(join(evalDir, 'run-eval.mjs')),
      join(evalDir, 'build-report-lite.mjs'),
    ].map((path) => relative(cliDir, path))
    expect(required.filter((path) => !listed.has(path))).toEqual([])
    expect(state.harness_paths).not.toContain('src/devices/dialSkill.ts')
  })
})
