import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { collect, readResults, runScenario, SETTLE_END_MS, uncaughtProbes, writeResults, type ScenarioRun } from './runner.js'
import { agentIdOf, StepNotBuilt, type Check, type EvalDriver, type Platform, type Scenario, type Seen, type SessionDef,
  type Step, type StepKind, type Tier } from './types.js'

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const claude = (key: string, n: number): SessionDef =>
  ({ key, app: 'claude', id: uuid(n), localId: `local_${uuid(100 + n)}`, title: `Eval ${key}`, cwd: `/work/eval-${key}`, ageMs: n * 1000 })
const A = claude('a', 1)
const B = claude('b', 2)
const GHOST: SessionDef = { ...claude('z', 9), ghost: true }

const ring = (expect: string[], extra: Partial<Check> = {}): Check => ({ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect, ...extra } as Check)
const cost: Check = { id: 'cost', kind: 'cost', dim: 'D8' }

function scenario(steps: Step[], checks: Check[] = [ring(['a', 'b'])], probes: Check[] = [ring(['a', 'b', 'z'])]): Scenario {
  return { id: 'S1', app: 'claude', title: 'Eval scenario', dims: ['D1'], platforms: ['darwin', 'linux', 'win32'],
    tiers: ['a', 'b'], heldOut: false, sessions: [A, B, GHOST], steps, checks, probes }
}

/** One push: the apps frame, then a whole ring of these sessions. */
const list = (at: number, rows: SessionDef[]): Seen['frames'] => [
  { at, message: { t: 'apps', shown: 'claude', apps: [] } },
  { at, message: { t: 'agents.begin' } },
  ...rows.map((r) => ({ at, message: { t: 'agent', id: agentIdOf(r), name: r.title } })),
  { at, message: { t: 'agents.end', total: rows.length, tab: '' } },
]

interface Script {
  tier?: Tier
  /** What the world does as a step runs. */
  onStep?(driver: Scripted, step: Exclude<Step, { kind: 'wait' }>): void
  /** What the world does at a virtual time, once time reaches it. */
  events?: Array<{ at: number; does(driver: Scripted): void }>
  gaps?: string[]
  throwOn?: { kind: StepKind; error: Error }
  onStop?(driver: Scripted): void
}

/** A driver whose world is a script, on a virtual clock that moves 100 ms at a time while it settles. */
class Scripted implements EvalDriver {
  readonly tier: Tier
  readonly calls: string[] = []
  readonly frames: Seen['frames'] = []
  cost: Seen['cost']
  private t = 0
  private scenario: Scenario | undefined
  private readonly steps: Seen['steps'] = []
  private readonly events: NonNullable<Script['events']>

  constructor(private readonly script: Script = {}) {
    this.tier = script.tier ?? 'a'
    this.events = [...script.events ?? []]
  }

  async start(s: Scenario, platform: Platform): Promise<void> {
    this.scenario = s
    this.calls.push(`start ${s.id} ${platform}`)
  }

  async step(step: Exclude<Step, { kind: 'wait' }>): Promise<void> {
    this.calls.push(`${step.kind} at ${this.t}`)
    this.steps.push({ at: this.t, index: this.scenario!.steps.indexOf(step), kind: step.kind, ...(step.label ? { label: step.label } : {}) })
    if (this.script.throwOn?.kind === step.kind) throw this.script.throwOn.error
    this.script.onStep?.(this, step)
  }

  async settle(ms: number, until?: () => boolean): Promise<void> {
    const end = this.t + ms
    while (this.t < end && !until?.()) {
      this.t += 100
      for (const event of this.events.filter((e) => e.at <= this.t)) {
        this.events.splice(this.events.indexOf(event), 1)
        event.does(this)
      }
    }
    this.calls.push(`settle ${ms} until ${this.t}`)
  }

  now(): number {
    return this.t
  }

  seen(): Seen {
    return { frames: [...this.frames], faces: [], commands: [], deliveries: [], steps: [...this.steps],
      ...(this.cost ? { cost: this.cost } : {}) }
  }

  gaps(): string[] {
    return this.script.gaps ?? []
  }

  async stop(): Promise<void> {
    this.calls.push('stop')
    this.script.onStop?.(this)
  }
}

const write: Step = { kind: 'claude.write', sessions: ['a', 'b'], label: 'write' }
const tap: Step = { kind: 'tap', session: 'a', label: 'tap' }
const parts = (run: ScenarioRun, which: 'results' | 'probes' = 'results'): Record<string, number> =>
  Object.fromEntries(run[which].map((r) => [r.check, r.score]))

it('steps run in order and labels are timed', async () => {
  const s = scenario([write, { kind: 'wait', ms: 500 }, tap], [ring(['a', 'b']), ring(['a', 'b'], { id: 'late', after: 'tap' })])
  const driver = new Scripted({ onStep: (d, step) => { if (step.kind === 'claude.write') d.frames.push(...list(d.now(), [A, B])) } })
  const run = await runScenario(driver, s, 'linux')
  expect(driver.calls).toEqual(['start S1 linux', 'claude.write at 0', 'settle 500 until 500', 'tap at 500',
    `settle ${SETTLE_END_MS} until ${500 + SETTLE_END_MS}`, 'stop'])
  // The list came at the write, before the tap: a check from the tap on sees none.
  expect(parts(run)['ring.recall']).toBe(1)
  expect(parts(run)['late.recall']).toBe(0)
})

it('a wait ends as soon as its check holds', async () => {
  const s = scenario([write, { kind: 'wait', ms: 5_000, until: 'ring' }, tap])
  const driver = new Scripted({ events: [{ at: 1_200, does: (d) => d.frames.push(...list(d.now(), [A, B])) }] })
  await runScenario(driver, s, 'darwin')
  expect(driver.calls.slice(1, 4)).toEqual(['claude.write at 0', 'settle 5000 until 1200', 'tap at 1200'])
})

it('a wait on a check the scenario does not have is refused', async () => {
  const driver = new Scripted()
  await expect(runScenario(driver, scenario([{ kind: 'wait', ms: 5_000, until: 'nope' }]), 'darwin')).rejects.toThrow(/nope/)
  expect(driver.calls.at(-1)).toBe('stop')
})

it('the world settles 6 s after the last step', async () => {
  expect(SETTLE_END_MS).toBe(6_000)
  // The list lands 5.9 s after the write: still inside the run.
  const driver = new Scripted({ events: [{ at: 5_900, does: (d) => d.frames.push(...list(d.now(), [A, B])) }] })
  const run = await runScenario(driver, scenario([write]), 'darwin')
  expect(driver.calls.slice(-2)).toEqual(['settle 6000 until 6000', 'stop'])
  expect(parts(run)['ring.recall']).toBe(1)
})

it("a driver's gap drops the scenario's results and lists it with its app", async () => {
  const driver = new Scripted({ tier: 'b', gaps: ['a platform read'], onStep: (d) => d.frames.push(...list(d.now(), [A, B])) })
  const run = await runScenario(driver, scenario([write]), 'win32')
  expect(run).toMatchObject({ scenario: 'S1', platform: 'win32', results: [], probes: [],
    gaps: [{ tier: 'b', platform: 'win32', scenario: 'S1', app: 'claude', reason: 'a platform read' }] })
  expect(uncaughtProbes(run)).toEqual([])
})

it('checks are evaluated on what the driver saw through its stop', async () => {
  // Tier B measures the devices process from start to the end of stop: the cost exists only once stop is done.
  const driver = new Scripted({ tier: 'b', onStop: (d) => { d.cost = { cpuPercent: 4, loopP99Ms: 30, leftovers: 0 } } })
  const run = await runScenario(driver, scenario([write], [cost], []), 'darwin')
  expect(parts(run)).toEqual({ 'cost.cpu': 1, 'cost.loopP99': 1, 'cost.leftovers': 1 })
  expect(run.results.every((r) => r.tier === 'b' && r.platform === 'darwin' && r.scenario === 'S1')).toBe(true)
})

it('probes are evaluated apart and not in the results', async () => {
  const pushes = new Scripted({ onStep: (d) => d.frames.push(...list(d.now(), [A, B])) })
  const run = await runScenario(pushes, scenario([write], [ring(['a', 'b'])], [ring(['a', 'b', 'z'], { id: 'ghost' })]), 'darwin')
  expect(Object.keys(parts(run)).every((check) => check.startsWith('ring.'))).toBe(true)
  expect(Object.keys(parts(run, 'probes')).every((check) => check.startsWith('ghost.'))).toBe(true)
  expect(parts(run, 'probes')['ghost.recall']).toBeLessThan(1)
  expect(uncaughtProbes(run)).toEqual([])
  expect(collect([run]).results).toEqual(run.results)

  // Seeing nothing leaves the probe's evidence empty: it is not caught.
  const blind = await runScenario(new Scripted(), scenario([write]), 'darwin')
  expect(uncaughtProbes(blind)).toEqual(['ring'])
})

it('a wrong send is listed with its tier and platform', async () => {
  const voice: Step = { kind: 'voice', transcript: 'Eval words', target: 'a' }
  const driver = new Scripted({ tier: 'b' })
  const s = scenario([voice])
  // The words reach b: what the driver saw, read through a delivery after the step.
  driver.seen = () => ({ frames: [], faces: [], commands: [], steps: [{ at: 0, index: 0, kind: 'voice' }],
    deliveries: [{ at: 300, path: 'mod', target: 'b', text: 'Eval words' }] })
  const run = await runScenario(driver, s, 'linux')
  expect(run.wrongSends).toEqual([{ tier: 'b', platform: 'linux', scenario: 'S1', target: 'a', got: 'b', path: 'mod', at: 300 }])
  expect(collect([run]).wrongSends).toEqual(run.wrongSends)
})

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

it('results files round-trip and merge', async () => {
  dir = mkdtempSync(join(tmpdir(), 'dial-eval-results-'))
  const a = collect([await runScenario(new Scripted({ onStep: (d) => d.frames.push(...list(d.now(), [A, B])) }), scenario([write]), 'darwin')])
  const b = collect([await runScenario(new Scripted({ tier: 'b', gaps: ['why'] }), scenario([write]), 'linux')])
  expect(basename(writeResults(dir, 'spec', a))).toBe('results-a-spec.json')
  expect(basename(writeResults(dir, 'claude', b))).toBe('results-b-claude.json')
  writeFileSync(join(dir, 'report.json'), '{}')
  expect(readResults(dir)).toEqual({ schema: 1, results: [...a.results, ...b.results], wrongSends: [], gaps: b.gaps })
})

it('the driver stops when a step throws', async () => {
  const failing = new Scripted({ throwOn: { kind: 'tap', error: new Error('boom') } })
  await expect(runScenario(failing, scenario([write, tap]), 'darwin')).rejects.toThrow('boom')
  expect(failing.calls.at(-1)).toBe('stop')

  const unbuilt = new Scripted({ throwOn: { kind: 'tap', error: new StepNotBuilt('tap', 'a') } })
  await expect(runScenario(unbuilt, scenario([write, tap]), 'darwin')).rejects.toBeInstanceOf(StepNotBuilt)
  expect(unbuilt.calls.at(-1)).toBe('stop')
})
