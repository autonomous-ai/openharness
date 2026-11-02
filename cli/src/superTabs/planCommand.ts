/** `harness super-tab plan [JSON]`: the best plan for all of a Lead's open work, from the scheduler (tools/scheduler,
 * docs/plans/2026-10-27-swarm-scheduler.md). Advisory only: it records nothing, and the route stays the source of every
 * decision; the Lead routes each group and passes the plan's pick as the override. The solver is Python with OR-Tools on the
 * Lead's machine; without either the command says how to install it, and the route works as before. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePlanRequest, planSetup } from './planInput.js'
import { catalogFrom } from './route.js'
import { CATALOG_UNREADABLE } from './routeCommand.js'
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

const whole = (dir: string, files: Record<string, string>) => Object.keys(files).every(name => existsSync(join(dir, 'scheduler', name)))

/** The folder to run the package from, and whether it is this process's own, to remove after the run. Two Leads' CLIs may plan
 *  at once, and another's solver may be importing from the published folder at any moment, so a published folder is never
 *  deleted or replaced (review of #1764): a whole copy is written to a folder of this process's own and renamed into place
 *  only where none is published yet. Should the published one be missing a file (a process that stopped while writing before
 *  publication was atomic, or a disk that lost it), this run uses its own whole copy instead. */
function packageFolder(root: string, files: Record<string, string>): { dir: string; own: boolean } {
  if (whole(root, files)) return { dir: root, own: false }
  const draft = `${root}.${process.pid}.${randomUUID()}`
  mkdirSync(join(draft, 'scheduler'), { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(draft, 'scheduler', name), text)
  if (!existsSync(root)) {
    try { renameSync(draft, root); return { dir: root, own: false } } catch { /* Another process published first. */ }
  }
  if (whole(root, files)) { rmSync(draft, { recursive: true, force: true }); return { dir: root, own: false } }
  return { dir: draft, own: true }
}

/** Runs `python -m scheduler plan` on [instance], with the package written once per version under the data folder. */
export async function runSolver(instance: Json, options: { dataDir: string; python?: string; pythonPath?: string[]; timeoutMs?: number }): ReturnType<SolverRun> {
  const files = schedulerFiles()
  const version = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16)
  const { dir: root, own } = packageFolder(join(options.dataDir, 'scheduler', version), files)
  const python = options.python ?? 'python3'
  const answer = await new Promise<Awaited<ReturnType<SolverRun>>>(resolve => {
    const child = spawn(python, ['-m', 'scheduler', 'plan', '--time-limit', String(TIME_LIMIT_SECONDS)], {
      cwd: root, env: { ...process.env, PYTHONPATH: [...(options.pythonPath ?? []), root].join(delimiter) }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    // Diego's issue, 2026-10-27: --time-limit is the solver's own promise; a python3 stuck on an import or in a deadlock left
    // the command waiting forever and its private package copy on disk. Past the limit and a margin to start, it is killed.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ error: 'SOLVER_FAILED', detail: 'timed out' })
    }, options.timeoutMs ?? TIME_LIMIT_SECONDS * 1000 + 20_000)
    let out = '', err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve(error.code === 'ENOENT'
        ? { error: 'PYTHON_MISSING', detail: `Python 3 is not installed on this machine (${python}). ${INSTALL}` }
        : { error: 'SOLVER_FAILED', detail: error.message })
    })
    child.on('close', code => {
      clearTimeout(timer)
      let value: Json | null = null
      try { value = object(JSON.parse(out)) } catch { /* Not JSON: said below with the solver's own words. */ }
      if (value && typeof value.error === 'string') resolve({ error: value.error, detail: String(value.detail ?? '') })
      else if (code === 0 && value) resolve({ ok: true, value })
      else resolve({ error: 'SOLVER_FAILED', detail: `The scheduler stopped (exit ${code}): ${err.trim().split('\n').slice(-3).join(' ')}` })
    })
    child.stdin.end(JSON.stringify(instance))
  })
  if (own) rmSync(root, { recursive: true, force: true })
  return answer
}

export async function planWork(input: { request: unknown }, scoped: ScopedRequest, deps: { run?: SolverRun; now?: () => number; dataDir: string; python?: string }): Promise<Json> {
  const request = parsePlanRequest(input.request)
  if (typeof request === 'string') return { error: 'INVALID_REQUEST', detail: request }
  const context = await scoped({ action: 'routeContext' })
  if (context.error || context.ok !== true) return context
  const value = object(context.value), tab = object(value.tab)
  const now = (deps.now ?? Date.now)()
  const catalog = catalogFrom(object(value.policy))
  const setup = planSetup({ state: object(tab.state), catalog, leadId: String(value.agentId),
    request, githubApp: tab.githubApp === true, now })
  if (!setup.instance.tasks.length) return { ok: true, plan: [], note: 'No open groups to plan.' }
  // What the plan could not follow, said with the plan or with why there is none (final review).
  const notes = [...(catalog.models.length ? [] : [CATALOG_UNREADABLE]),
    ...setup.understrength.map(id => `No model that can run ${setup.titles[id]} is as strong as its difficulty asks: it is planned on the strongest that can.`)]
  const solved = await (deps.run ?? (instance => runSolver(instance, { dataDir: deps.dataDir, python: deps.python })))(setup.instance)
  if ('error' in solved) return { error: solved.error, detail: `${solved.detail} Route each group as usual meanwhile.` }
  const answer = solved.value
  if (answer.status !== 'OPTIMAL' && answer.status !== 'FEASIBLE') {
    return { error: 'NO_PLAN', detail: `The scheduler found no plan: ${String(answer.reason || answer.status)}. Route each group as usual.`, ...(notes.length ? { notes } : {}) }
  }
  const route = object(answer.route)
  const plan = list(answer.plan).map(row => {
    const group = String(row.task), machineId = String(row.machine), modelId = String(row.model), pick = setup.rows[modelId]!
    // A model on the grid is started by its gridModel and gridName, never a model or effort (route.ts).
    const runs = pick.gridModel ? { engine: pick.engine, gridModel: pick.gridModel, gridName: pick.gridName }
      : { engine: pick.engine, model: pick.model, effort: pick.effort }
    return { order: Number(row.order), groupId: group, group: setup.titles[group], machineId, machine: setup.machineNames[machineId], ...runs,
      startsInMinutes: Number(row.start), finishesInMinutes: Number(row.end), finishAt: new Date(now + Number(row.end) * 60_000).toISOString() }
  })
  return {
    ok: true, status: answer.status, makespanMinutes: answer.makespan, cost: answer.cost,
    route: { makespanMinutes: route.makespan, cost: route.cost }, plan,
    estimates: setup.estimates.map(id => setup.titles[id]), leftOut: setup.leftOut, ignored: setup.ignored, ...(notes.length ? { notes } : {}),
    next: 'Follow the plan in order. For each group: route it as usual, then start (or assign) the plan\'s pick with the route\'s routeDecisionId '
      + 'and overrideReason "scheduler plan" when it differs from the route\'s. Groups marked as estimates were planned at medium; '
      + 'pass {"groups":{"GROUP":{"difficulty":…,"risk":…,"size":…}}} to plan them as assessed.',
  }
}
