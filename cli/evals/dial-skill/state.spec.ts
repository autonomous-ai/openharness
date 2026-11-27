import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DIAL_SKILL } from '../../src/devices/dialSkill.js'
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
  bases: Record<string, number>
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

  // Targets are read on val and test: a trap only in train would never count against a needless ring there.
  it('holds the fyi trap and an offer trap out of train', () => {
    const kind = new Map(loadScenarios().map((s) => [caseId(s.id, 'claude'), s.kind]))
    const heldOut = [...state.val_ids, ...state.test_ids].map((id) => kind.get(id))
    expect(heldOut).toContain('fyi-trap')
    expect(heldOut).toContain('offer-trap')
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

  it('declares loaded, a rate outside the guardrails', () => {
    expect(state.metrics.find((m) => m.id === 'loaded')).toEqual({
      id: 'loaded',
      label: 'Loaded',
      kind: 'float',
      scale: 1,
    })
    expect(state.goal.hold).not.toContain('loaded')
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

  // v7 measures the closing bullet alone: v5, the shipped Part 5 (v4's skill, its session-start line and the Stop hook),
  // with the bullet added to the body.
  it('flow/v7 is v5 with the closing bullet', () => {
    const read = (variant: string, name: string) => readFileSync(join(evalDir, 'flow', variant, name), 'utf8')
    expect(read('v7', 'SKILL.md')).toBe(DIAL_SKILL)
    expect(read('v7', 'SKILL.before.md')).toBe(read('v5', 'SKILL.md'))
    for (const name of ['hooks.json', 'harness-answers.json']) {
      expect(read('v7', name), name).toBe(read('v5', name))
      expect(state.harness_paths).toContain(`evals/dial-skill/flow/v7/${name}`)
    }
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

// What the runner's variantHooks reads from a variant (run-eval.mjs keeps it private): its hooks and the fake's answers.
type Answer = { argv: string[]; stdout?: string; stop?: true }
function variant(name: string): { hooks: Record<string, any[]>; answers: Answer[]; skill: string } {
  const dir = join(evalDir, 'flow', name)
  const json = (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'))
  return { hooks: json('hooks.json'), answers: json('harness-answers.json'), skill: readFileSync(join(dir, 'SKILL.md'), 'utf8') }
}
const stopHook = [{ hooks: [{ type: 'command', command: 'harness device claude stop', timeout: 5 }] }]
const isStop = (a: Answer) => a.argv.join(' ') === 'device claude stop'
const blockOf = (answers: Answer[]) => JSON.parse(answers.find(isStop)!.stdout!) as { decision: string; reason: string }

describe('the Stop hook variants', () => {
  it('flow/v5 is v4 with the Stop hook', () => {
    const v4 = variant('v4')
    const v5 = variant('v5')
    expect(v5.hooks).toEqual({ SessionStart: v4.hooks.SessionStart, Stop: stopHook })
    expect(v5.answers.filter((a) => !isStop(a))).toEqual(v4.answers)
    expect(v5.answers.filter(isStop)).toHaveLength(1)
    expect(v5.answers.find(isStop)!.stop).toBe(true)
    expect(v5.skill).toBe(v4.skill)
  })

  it('flow/v6 is v1 with the Stop hook alone', () => {
    const v6 = variant('v6')
    expect(v6.hooks).toEqual({ Stop: stopHook })
    expect(v6.answers).toHaveLength(1)
    expect(isStop(v6.answers[0]) && v6.answers[0].stop).toBe(true)
    expect(v6.skill).toBe(readFileSync(join(evalDir, 'flow', 'v1', 'SKILL.md'), 'utf8'))
  })

  it('answers the Stop hook with the same block in both, one line of the reason', () => {
    const v5 = variant('v5').answers.find(isStop)!.stdout!
    expect(variant('v6').answers.find(isStop)!.stdout).toBe(v5)
    expect(v5.endsWith('\n')).toBe(true)
    expect(v5.slice(0, -1)).not.toContain('\n')
    const block = blockOf(variant('v5').answers)
    expect(Object.keys(block)).toEqual(['decision', 'reason'])
    expect(block.decision).toBe('block')
    expect(block.reason).toMatch(/^[\x20-\x7e]+$/)
    expect(block.reason).not.toMatch(/[<>]/)
    expect(block.reason).toContain('harness device notify')
  })

  it('pairs v5 with v4 and v6 with v1', () => {
    expect(state.bases).toEqual({ v5: 4, v6: 1 })
  })
})
