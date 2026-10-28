import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planWork, runSolver, schedulerFiles, type SolverRun } from './planCommand.js'
import { group, machine, NOW, policy, state, type Json } from './fixtures/planState.js'

const context = (s: Json) => ({ ok: true, value: { tab: { state: s, githubApp: false }, policy: { policy, warnings: [] }, agentId: 'lead1', machines: [] } })
const scoped = (s: Json) => vi.fn(async (payload: Json) => payload.action === 'routeContext' ? context(s) : { error: 'UNEXPECTED' })
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

/** What `python -m scheduler plan` prints for g1 and g2 (tools/scheduler/scheduler/plan.py). */
const answer = (plan: Json[]): Awaited<ReturnType<SolverRun>> => ({ ok: true, value: { status: 'OPTIMAL', reason: '', makespan: 180, cost: 540, gap: 0, seconds: 0.1, plan,
  route: { status: 'EVALUATED', makespan: 240, cost: 600, plan: [] } } })

describe('planWork', () => {
  const rules = [{ projectId: 'p1', rule: { kind: 'minEffort', effort: 'high' }, text: 'At least high.' }]
  const served = { localModels: [{ grid: 'swarm-g', model: 'deepseek/flash', name: 'DeepSeek', kind: 'api' }] }

  it('gives each open group its machine, engine, model and effort, start order and expected finish, against the route', async () => {
    const run = vi.fn<SolverRun>(async () => answer([
      { task: 'g1', machine: 'm1', model: 'codex-default-default', start: 0, end: 60, order: 1 },
      { task: 'g2', machine: 'm2', model: 'grid:deepseek/flash', start: 60, end: 180, order: 2 }]))
    const s = state({ rules, machines: [machine('m1', {}, served), machine('m2')] })
    const out = await planWork({ request: { groups: { g1: { difficulty: 'high', risk: 'low', size: 'medium' } } } }, scoped(s), { run, now: () => NOW, dataDir: '/unused' })
    expect((run.mock.calls[0]![0].tasks as Json[]).map(t => t.id)).toEqual(['g1', 'g2'])
    expect(out).toEqual({
      ok: true, status: 'OPTIMAL', makespanMinutes: 180, cost: 540, route: { makespanMinutes: 240, cost: 600 },
      plan: [
        // Codex default leaves the effort to the engine, so it starts at the project's minimum, as the route lifts it.
        { order: 1, groupId: 'g1', group: 'Group g1', machineId: 'm1', machine: 'm1.local', engine: 'codex', model: 'default', effort: 'high',
          startsInMinutes: 0, finishesInMinutes: 60, finishAt: at(60) },
        { order: 2, groupId: 'g2', group: 'Group g2', machineId: 'm2', machine: 'm2.local', engine: 'claude', gridModel: 'deepseek/flash', gridName: 'swarm-g',
          startsInMinutes: 60, finishesInMinutes: 180, finishAt: at(180) },
      ],
      estimates: ['Group g2'], leftOut: [], ignored: [],
      next: expect.stringContaining('overrideReason "scheduler plan"'),
    })
  })

  it('says why machines were left out', async () => {
    const run = vi.fn<SolverRun>(async () => answer([{ task: 'g1', machine: 'm1', model: 'claude-opus-high', start: 0, end: 60, order: 1 },
      { task: 'g2', machine: 'm1', model: 'claude-opus-high', start: 60, end: 120, order: 2 }]))
    const out = await planWork({ request: undefined }, scoped(state({ machines: [machine('m1'), machine('m2', { paused: true })] })), { run, now: () => NOW, dataDir: '/unused' })
    expect(out.leftOut).toEqual([{ machine: 'm2.local', reason: 'New work is paused on this machine.' }])
  })

  it('without OR-Tools, says how to install it and that the route works as before', async () => {
    const run = vi.fn<SolverRun>(async () => ({ error: 'ORTOOLS_MISSING', detail: 'OR-Tools is not installed for python3. Install it with: python3 -m pip install ortools==9.15.6755' }))
    const out = await planWork({ request: undefined }, scoped(state()), { run, now: () => NOW, dataDir: '/unused' })
    expect(out).toEqual({ error: 'ORTOOLS_MISSING', detail: 'OR-Tools is not installed for python3. Install it with: python3 -m pip install ortools==9.15.6755 Route each group as usual meanwhile.' })
  })

  it('reports a plan the scheduler cannot make, and why', async () => {
    const run = vi.fn<SolverRun>(async () => ({ ok: true, value: { status: 'INFEASIBLE', reason: 'no machine and model meet the floor of: g1', plan: [], route: {} } }))
    const out = await planWork({ request: undefined }, scoped(state()), { run, now: () => NOW, dataDir: '/unused' })
    expect(out).toEqual({ error: 'NO_PLAN', detail: 'The scheduler found no plan: no machine and model meet the floor of: g1. Route each group as usual.' })
  })

  it('plans nothing, without running the solver, when no group is open', async () => {
    const run = vi.fn<SolverRun>()
    const out = await planWork({ request: undefined }, scoped(state({ conversations: [group('g1', { archived: true })] })), { run, now: () => NOW, dataDir: '/unused' })
    expect(out).toEqual({ ok: true, plan: [], note: 'No open groups to plan.' })
    expect(run).not.toHaveBeenCalled()
  })

  it('runs the solver on this machine by default, and says when it cannot', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'plan-')), python = join(dataDir, 'no-python3')
    try {
      const out = await planWork({ request: undefined }, scoped(state()), { now: () => NOW, dataDir, python })
      expect(out).toEqual({ error: 'PYTHON_MISSING', detail: expect.stringMatching(/^Python 3 is not installed on this machine.*Route each group as usual meanwhile\.$/) })
    } finally { rmSync(dataDir, { recursive: true, force: true }) }
  })

  it('refuses a bad request and passes on a failed read', async () => {
    const run = vi.fn<SolverRun>()
    expect(await planWork({ request: { groups: { g1: { difficulty: 'hard' } } } }, scoped(state()), { run, now: () => NOW, dataDir: '/unused' }))
      .toEqual({ error: 'INVALID_REQUEST', detail: 'Set difficulty of g1 to low, medium or high.' })
    const failing = vi.fn(async () => ({ error: 'LEAD_REQUIRED', detail: 'Only a Lead plans.' }))
    expect(await planWork({ request: undefined }, failing, { run, now: () => NOW, dataDir: '/unused' })).toEqual({ error: 'LEAD_REQUIRED', detail: 'Only a Lead plans.' })
  })
})

describe('the solver files', () => {
  it('are the scheduler package, without its tests', () => {
    const files = schedulerFiles()
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['__init__.py', '__main__.py', 'plan.py', 'solver.py', 'greedy.py', 'instance.py']))
    expect(Object.keys(files).every(f => f.endsWith('.py') && !f.startsWith('test'))).toBe(true)
  })
})

const instance = { tasks: [{ id: 'g1', title: 'g1', minutes: 60, floor: 1 }], machines: [{ id: 'm1', name: 'm1', slots: 1, engines: ['claude'] }],
  models: [{ id: 'opus', engine: 'claude', cost: 3, quality: { default: 3 } }], accounts: [] }
const hasPython = (python: string, code = 'pass') => spawnSync(python, ['-c', code]).status === 0
// The solve itself needs OR-Tools: SCHEDULER_PYTHON names a Python that has it (tools/scheduler/README.md).
const solverPython = process.env.SCHEDULER_PYTHON ?? 'python3'

describe('runSolver', () => {
  const dirs: string[] = []
  const temp = () => { const d = mkdtempSync(join(tmpdir(), 'plan-')); dirs.push(d); return d }
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('says when Python is not installed', async () => {
    expect(await runSolver(instance, { dataDir: temp(), python: join(temp(), 'no-python3') }))
      .toEqual({ error: 'PYTHON_MISSING', detail: expect.stringContaining('Python 3 is not installed') })
  })

  it.skipIf(!hasPython('python3'))('never touches a package another process published, and runs from a whole copy of its own', async () => {
    const dataDir = temp(), fake = temp()
    mkdirSync(join(fake, 'ortools'))
    writeFileSync(join(fake, 'ortools', '__init__.py'), "raise ImportError('No module named ortools')\n")
    await runSolver(instance, { dataDir, python: 'python3', pythonPath: [fake] })
    const [version] = readdirSync(join(dataDir, 'scheduler')), root = join(dataDir, 'scheduler', version!), pkg = join(root, 'scheduler')
    // Another CLI process stopped while writing: the package has its entry point but not the solver.
    rmSync(join(pkg, 'solver.py'))
    const before = statSync(root).ino, kept = readdirSync(pkg).sort()
    // A solver still running from that folder imports one more module after the others have published.
    const importer = promisify(execFile)('python3', ['-c', 'import time, scheduler; time.sleep(2); import scheduler.instance; print("imported")'], { cwd: root, timeout: 30_000 })
    // Each publisher waits at the barrier, so all of them find the package half-written at once.
    const barrier = join(temp(), 'go')
    const script = `
      import { existsSync } from 'node:fs';
      import { runSolver } from './src/superTabs/planCommand.ts';
      while (!existsSync(process.argv[1])) await new Promise(r => setTimeout(r, 5));
      const instance = { tasks: [{ id: 'g1', minutes: 60 }], machines: [{ id: 'm1', slots: 1, engines: ['claude'] }], models: [{ id: 'opus', engine: 'claude', cost: 3, quality: { default: 3 } }] };
      console.log(JSON.stringify(await runSolver(instance, { dataDir: process.argv[2], python: 'python3', pythonPath: [process.argv[3]] })));
    `
    const run = promisify(execFile)
    const children = [1, 2, 3, 4, 5, 6].map(() => run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, barrier, dataDir, fake], { timeout: 30_000 }))
    await new Promise(r => setTimeout(r, 1000))
    writeFileSync(barrier, '')
    const answers = (await Promise.all(children)).map(c => JSON.parse(c.stdout.trim()))
    // Every publisher ran a whole package: each reached the missing OR-Tools, none failed partway through its imports.
    expect(answers.map(a => a.error)).toEqual(Array(6).fill('ORTOOLS_MISSING'))
    expect((await importer).stdout.trim()).toBe('imported')
    // The folder the running solver uses is the same one, untouched, and no private copy is left behind.
    expect(statSync(root).ino).toBe(before)
    expect(readdirSync(pkg).sort()).toEqual(kept)
    expect(readdirSync(join(dataDir, 'scheduler'))).toEqual([version])
  }, 60_000)

  it('says when the solver stops without a plan', async () => {
    // A program that exits 1 and prints nothing stands in for a solver that crashed.
    expect(await runSolver(instance, { dataDir: temp(), python: process.platform === 'win32' ? 'cmd' : 'false' }))
      .toEqual({ error: 'SOLVER_FAILED', detail: expect.stringContaining('The scheduler stopped (exit 1)') })
  })

  // Diego's issue, 2026-10-27: --time-limit is only the solver's own promise. A python3 stuck on an import or in a deadlock
  // left the plan command waiting forever, and its private copy of the package on disk.
  it.skipIf(process.platform === 'win32')('a solver that never exits is killed and reported', async () => {
    const dataDir = temp(), bin = temp()
    // A first run publishes the package; with a file missing from it, the next run works from a private copy of its own.
    await runSolver(instance, { dataDir, python: join(bin, 'no-python3') })
    const [version] = readdirSync(join(dataDir, 'scheduler'))
    rmSync(join(dataDir, 'scheduler', version!, 'scheduler', 'solver.py'))
    const hung = join(bin, 'python3')
    writeFileSync(hung, '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 })
    const started = Date.now()
    expect(await runSolver(instance, { dataDir, python: hung, timeoutMs: 200 })).toEqual({ error: 'SOLVER_FAILED', detail: 'timed out' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(readdirSync(join(dataDir, 'scheduler'))).toEqual([version])
  }, 10_000)

  it.skipIf(!hasPython('python3'))('says when OR-Tools is not installed', async () => {
    const fake = temp()
    mkdirSync(join(fake, 'ortools'))
    writeFileSync(join(fake, 'ortools', '__init__.py'), "raise ImportError('No module named ortools')\n")
    const out = await runSolver(instance, { dataDir: temp(), python: 'python3', pythonPath: [fake] })
    expect(out).toEqual({ error: 'ORTOOLS_MISSING', detail: expect.stringContaining('pip install ortools') })
  })

  it.skipIf(!hasPython(solverPython, 'import ortools'))('solves with the files written to the data folder', async () => {
    const out = await runSolver(instance, { dataDir: temp(), python: solverPython })
    expect(out).toMatchObject({ ok: true, value: { status: 'OPTIMAL', makespan: 60, plan: [{ task: 'g1', machine: 'm1', model: 'opus', start: 0, end: 60, order: 1 }] } })
  })
})
