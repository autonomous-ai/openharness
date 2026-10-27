/** `harness super-tab plan [JSON]`: the best plan for all of a Lead's open work, from the scheduler (tools/scheduler,
 * docs/plans/2026-10-27-swarm-scheduler.md). Advisory only: it records nothing, and the route stays the source of every
 * decision; the Lead routes each group and passes the plan's pick as the override. The solver is Python with OR-Tools on the
 * Lead's machine; without either the command says how to install it, and the route works as before. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePlanRequest, planSetup } from './planInput.js'
import type { Policy } from './route.js'
import type { ScopedRequest } from './start.js'
import { object } from './wire.js'

type Json = Record<string, unknown>
export type SolverRun = (instance: Json) => Promise<{ ok: true; value: Json } | { error: string; detail: string }>

declare const __SCHEDULER_FILES__: Record<string, string> | undefined
/** How long the solver may think: the brief's limit for 30 tasks on 8 machines with 6 models (it takes about a quarter second). */
const TIME_LIMIT_SECONDS = 10
const INSTALL = 'Install Python 3 (python.org, or brew install python), then: python3 -m pip install ortools==9.15.6755.'
const list = (value: unknown) => Array.isArray(value) ? value.map(object) : []

/** The scheduler package's files. The release bundle carries them inside cli.js (build-bundle.mjs `define`), as the installed
 *  CLI has nothing beside it to read; a dev checkout and the tests read tools/scheduler/scheduler itself (src/superTabs/ and
 *  dist/superTabs/ are both three levels below the repository). */
export function schedulerFiles(): Record<string, string> {
  if (typeof __SCHEDULER_FILES__ === 'object' && __SCHEDULER_FILES__) return __SCHEDULER_FILES__
  const dir = fileURLToPath(new URL('../../../tools/scheduler/scheduler/', import.meta.url))
  return Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.py')).sort().map(f => [f, readFileSync(join(dir, f), 'utf8')]))
}

/** Runs `python -m scheduler plan` on [instance], with the package written once per version under the data folder. */
export async function runSolver(instance: Json, options: { dataDir: string; python?: string; pythonPath?: string[] }): ReturnType<SolverRun> {
  const files = schedulerFiles()
  const version = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16)
  const root = join(options.dataDir, 'scheduler', version), pkg = join(root, 'scheduler')
  if (!existsSync(join(pkg, '__main__.py'))) {
    mkdirSync(pkg, { recursive: true })
    for (const [name, text] of Object.entries(files)) writeFileSync(join(pkg, name), text)
  }
  const python = options.python ?? 'python3'
  return new Promise(resolve => {
    const child = spawn(python, ['-m', 'scheduler', 'plan', '--time-limit', String(TIME_LIMIT_SECONDS)], {
      cwd: root, env: { ...process.env, PYTHONPATH: [...(options.pythonPath ?? []), root].join(delimiter) }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ENOENT'
      ? { error: 'PYTHON_MISSING', detail: `Python 3 is not installed on this machine (${python}). ${INSTALL}` }
      : { error: 'SOLVER_FAILED', detail: error.message }))
    child.on('close', code => {
      let value: Json | null = null
      try { value = object(JSON.parse(out)) } catch { /* Not JSON: said below with the solver's own words. */ }
      if (value && typeof value.error === 'string') resolve({ error: value.error, detail: String(value.detail ?? '') })
      else if (code === 0 && value) resolve({ ok: true, value })
      else resolve({ error: 'SOLVER_FAILED', detail: `The scheduler stopped (exit ${code}): ${err.trim().split('\n').slice(-3).join(' ')}` })
    })
    child.stdin.end(JSON.stringify(instance))
  })
}

export async function planWork(input: { request: unknown }, scoped: ScopedRequest, deps: { run?: SolverRun; now?: () => number; dataDir: string; python?: string }): Promise<Json> {
  const request = parsePlanRequest(input.request)
  if (typeof request === 'string') return { error: 'INVALID_REQUEST', detail: request }
  const context = await scoped({ action: 'routeContext' })
  if (context.error || context.ok !== true) return context
  const value = object(context.value), tab = object(value.tab)
  const now = (deps.now ?? Date.now)()
  const setup = planSetup({ state: object(tab.state), policy: object(value.policy).policy as Policy, leadId: String(value.agentId),
    request, githubApp: tab.githubApp === true, now })
  if (!setup.instance.tasks.length) return { ok: true, plan: [], note: 'No open groups to plan.' }
  const solved = await (deps.run ?? (instance => runSolver(instance, { dataDir: deps.dataDir, python: deps.python })))(setup.instance)
  if ('error' in solved) return { error: solved.error, detail: `${solved.detail} Route each group as usual meanwhile.` }
  const answer = solved.value
  if (answer.status !== 'OPTIMAL' && answer.status !== 'FEASIBLE') {
    return { error: 'NO_PLAN', detail: `The scheduler found no plan: ${String(answer.reason || answer.status)}. Route each group as usual.` }
  }
  const route = object(answer.route)
  const plan = list(answer.plan).map(row => {
    const group = String(row.task), machineId = String(row.machine), modelId = String(row.model), pick = setup.rows[modelId]!
    // A model on the grid is started by its gridModel and gridName, never a model or effort (route.ts).
    const runs = pick.gridModel ? { engine: pick.engine, gridModel: pick.gridModel, gridName: pick.gridName }
      : { engine: pick.engine, model: pick.model, effort: setup.effortFor(group, modelId) }
    return { order: Number(row.order), groupId: group, group: setup.titles[group], machineId, machine: setup.machineNames[machineId], ...runs,
      startsInMinutes: Number(row.start), finishesInMinutes: Number(row.end), finishAt: new Date(now + Number(row.end) * 60_000).toISOString() }
  })
  return {
    ok: true, status: answer.status, makespanMinutes: answer.makespan, cost: answer.cost,
    route: { makespanMinutes: route.makespan, cost: route.cost }, plan,
    estimates: setup.estimates.map(id => setup.titles[id]), leftOut: setup.leftOut, ignored: setup.ignored,
    next: 'Follow the plan in order. For each group: route it as usual, then start (or assign) the plan\'s pick with the route\'s routeDecisionId '
      + 'and overrideReason "scheduler plan" when it differs from the route\'s. Groups marked as estimates were planned at medium; '
      + 'pass {"groups":{"GROUP":{"difficulty":…,"risk":…,"size":…}}} to plan them as assessed.',
  }
}
