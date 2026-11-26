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
  goal: { hold: string[] }
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

  it('holds 38 scenarios, 13 / 13 / 12', () => {
    expect(loadScenarios()).toHaveLength(38)
    expect(Object.values(splits).map((ids) => ids.length)).toEqual([13, 13, 12])
  })

  it('splits need and no-need cases 8/5, 8/5, 8/4', () => {
    const need = new Map(loadScenarios().map((s) => [caseId(s.id, 'claude'), s.need]))
    const counts = Object.fromEntries(
      Object.entries(splits).map(([name, ids]) => [
        name,
        [ids.filter((id) => need.get(id) === 'need').length, ids.filter((id) => need.get(id) === 'no-need').length],
      ]),
    )
    expect(counts).toEqual({ train: [8, 5], val: [8, 5], test: [8, 4] })
  })

  it('headlines score and declares no binary metric', () => {
    expect(state.metrics[0].id).toBe('score')
    expect(state.metrics.filter((m) => m.kind === 'binary')).toEqual([])
  })

  it('declares one_step, a rate outside the guardrails', () => {
    expect(state.metrics.find((m) => m.id === 'one_step')).toEqual({
      id: 'one_step',
      label: 'One step',
      kind: 'float',
      scale: 1,
    })
    expect(state.goal.hold).not.toContain('one_step')
  })

  it('lists every crowd file', () => {
    const listed = new Set(state.harness_paths)
    const crowd = filesUnder(join(evalDir, 'crowd')).map((path) => relative(cliDir, path))
    expect(crowd.length).toBeGreaterThan(0)
    expect(crowd.filter((path) => !listed.has(path))).toEqual([])
  })

  // The runner refuses an unlisted hooks.json or harness-answers.json, since hooks run outside Claude's sandbox.
  it("lists every variant's hooks.json and harness-answers.json", () => {
    const listed = new Set(state.harness_paths)
    const flowDir = join(evalDir, 'flow')
    const variantFiles = readdirSync(flowDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => ['hooks.json', 'harness-answers.json'].map((name) => join(flowDir, entry.name, name)))
      .filter((path) => existsSync(path))
      .map((path) => relative(cliDir, path))
    expect(variantFiles.filter((path) => !listed.has(path))).toEqual([])
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
