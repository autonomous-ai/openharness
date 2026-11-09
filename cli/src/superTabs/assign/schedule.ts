/**
 * The serial schedule builder (model.ts): it takes tasks in a choice's order and starts each, on its chosen builder and
 * mode, at the earliest minute every constraint allows, never moving one already placed. Every constraint is exact here,
 * so the search (search.ts) only ever compares plans that can run:
 *
 * - a builder does one task at a time, after its work in progress (`busyUntil`);
 * - a task starts after its dependencies end and not before it is ready;
 * - a machine's CPU, memory and disk are never over what it has for Swarm work, at any minute;
 * - a model with a limit runs at most that many tasks at once, across the team;
 * - two tasks that change the same file never run at once on two builders;
 * - a subscription's windows are never spent past what is left after its person's reserve; a task that spans a reset spends
 *   each window its share of its minutes, and a window refills at each reset;
 * - a review is never done by its build's model family, nor by its author.
 */
import type { Account, Builder, Choice, Machine, Mode, Plan, Placement, Problem, QuotaWindow, Resources, Task } from './model.js'

/** No plan looks further than this: a task that cannot start within it is reported as having no room. */
export const HORIZON_MINUTES = 30 * 24 * 60
/** What a task left out costs a plan: more than any plan that places it. */
const UNPLACED = 1e12

interface Span { start: number; end: number }
interface MachineUse extends Span { needs: Resources }

/** Why [task] can never run on [builder] in [mode], or null when it can. */
export function unfit(task: Task, builder: Builder, mode: Mode, machine: Machine | undefined): string | null {
  if (task.pinned && task.pinned !== builder.id) return 'it is pinned to another builder'
  if (task.notBuilders.includes(builder.id)) return task.notWhy ?? 'this builder is its author'
  if (!machine) return 'its builder\'s machine is not in the plan'
  if ((mode.quality[task.kind] ?? mode.quality.default ?? 0) < task.floor) return 'no model of this builder is good enough for it'
  const { cpu, ram, disk } = machine.capacity
  if (task.needs.cpu > cpu || task.needs.ram > ram || task.needs.disk > disk) return 'it needs more than this builder\'s machine has'
  return null
}

/** Every builder and mode [task] may run on, in the problem's order, or why there is none. */
export function optionsOf(problem: Problem, task: Task): Array<{ builder: string; mode: number }> | string {
  const machines = new Map(problem.machines.map(m => [m.id, m]))
  const found: Array<{ builder: string; mode: number }> = []
  let why = 'no builder can do it'
  for (const builder of problem.builders) {
    builder.modes.forEach((mode, index) => {
      const reason = unfit(task, builder, mode, machines.get(builder.machine))
      if (reason) why = reason; else found.push({ builder: builder.id, mode: index })
    })
  }
  return found.length ? found : why
}

/** Minutes [task] takes on [builder] in [mode]: its minutes at the model's speed, at the builder's speed on its part. */
export function durationOf(task: Task, builder: Builder, mode: Mode): number {
  const context = task.part === undefined ? 1 : builder.context[task.part] ?? 1
  return Math.max(1, Math.ceil(task.minutes / mode.speed * context))
}

/** The plan built so far, which a task's earliest start is read from and which placing it adds to. */
export class Timeline {
  private readonly machines: Map<string, Machine>
  private readonly accounts: Map<string, Account>
  private readonly builders: Map<string, Builder>
  private readonly tasks: Map<string, Task>
  private readonly free = new Map<string, number>()
  private readonly machineUse = new Map<string, MachineUse[]>()
  private readonly modelUse = new Map<string, Span[]>()
  private readonly fileUse = new Map<string, Array<Span & { builder: string }>>()
  /** Percent spent of each account's window, by account, window name and the window's index from now. */
  private readonly spent = new Map<string, Map<number, number>>()
  readonly placed = new Map<string, Placement & { family: string }>()
  /** The tasks that name each task in their `independentOf`: its reviews, found without walking every placed task. */
  private readonly dependents = new Map<string, string[]>()

  constructor(readonly problem: Problem) {
    for (const task of problem.tasks) for (const other of task.independentOf) push(this.dependents, other, task.id)
    this.machines = new Map(problem.machines.map(m => [m.id, m]))
    this.accounts = new Map(problem.accounts.map(a => [a.id, a]))
    this.builders = new Map(problem.builders.map(b => [b.id, b]))
    this.tasks = new Map(problem.tasks.map(t => [t.id, t]))
    for (const builder of problem.builders) this.free.set(builder.id, Math.max(problem.now, builder.busyUntil))
  }

  /** The earliest [task] can start and end on [builderId] in [modeIndex], given what is placed, or why it cannot. */
  earliest(task: Task, builderId: string, modeIndex: number): Span | { why: string } {
    const builder = this.builders.get(builderId)
    const mode = builder?.modes[modeIndex]
    if (!builder || !mode) return { why: 'no such builder or model' }
    const machine = this.machines.get(builder.machine)
    const reason = unfit(task, builder, mode, machine)
    if (reason) return { why: reason }
    // A review is never read by its build's family; they may be placed in either order.
    for (const other of task.independentOf) {
      if (this.placed.get(other)?.family === mode.family) return { why: 'its build used this model family' }
    }
    for (const other of this.dependents.get(task.id) ?? []) {
      if (this.placed.get(other)?.family === mode.family) return { why: 'its review used this model family' }
    }
    let from = Math.max(this.problem.now, task.ready, this.free.get(builderId)!)
    for (const dep of task.deps) {
      const done = this.placed.get(dep)
      if (!done) return { why: `it waits on ${dep}` }
      from = Math.max(from, done.end)
    }
    const minutes = durationOf(task, builder, mode)
    const account = mode.account ? this.accounts.get(mode.account) : undefined
    for (const start of this.candidates(from, builder.machine, mode, task, account)) {
      const span = { start, end: start + minutes }
      if (this.machineFits(machine!, task.needs, span) && this.modelFits(mode, span) && this.filesFree(task, builderId, span)
        && this.quotaFits(account, task, mode, span)) return span
    }
    return { why: 'no room for it within 30 days' }
  }

  /** Adds [task] at [span]: its builder, machine, model, files and quota are held for it from then on. */
  place(task: Task, builderId: string, modeIndex: number, span: Span): void {
    const builder = this.builders.get(builderId)!
    const mode = builder.modes[modeIndex]!
    this.placed.set(task.id, { task: task.id, builder: builderId, mode: modeIndex, start: span.start, end: span.end, family: mode.family })
    this.free.set(builderId, span.end)
    push(this.machineUse, builder.machine, { ...span, needs: task.needs })
    if (mode.limit !== undefined) push(this.modelUse, mode.model, span)
    for (const file of task.files) push(this.fileUse, file, { ...span, builder: builderId })
    const account = mode.account ? this.accounts.get(mode.account) : undefined
    if (account) {
      for (const window of account.windows) {
        for (const [index, share] of shares(window, task, mode, span)) {
          const used = this.spent.get(`${account.id}\n${window.name}`) ?? new Map<number, number>()
          used.set(index, (used.get(index) ?? 0) + share)
          this.spent.set(`${account.id}\n${window.name}`, used)
        }
      }
    }
  }

  /** The minutes worth trying, earliest first: [from], each end of what holds this machine, model or task's files, and each
   *  reset of the account's windows, within the horizon. The earliest start is always one of them. Made one at a time, as
   *  the first that fits ends the search: listing and sorting a month of 5-hour resets for every placement was half of
   *  the solver's time (profile of 200 tasks, 2026-11-09). */
  private *candidates(from: number, machine: string, mode: Mode, task: Task, account: Account | undefined): Generator<number> {
    const limit = this.problem.now + HORIZON_MINUTES
    const ends: number[] = []
    for (const use of this.machineUse.get(machine) ?? []) if (use.end > from) ends.push(use.end)
    if (mode.limit !== undefined) for (const use of this.modelUse.get(mode.model) ?? []) if (use.end > from) ends.push(use.end)
    for (const file of task.files) for (const use of this.fileUse.get(file) ?? []) if (use.end > from) ends.push(use.end)
    ends.sort((a, b) => a - b)
    // Each window's resets after [from], as the old list kept them: those after now and before [from] plus the horizon.
    const resets = (account?.windows ?? []).map(window => ({ window, at: firstReset(window, from, this.problem.now) }))
    let last = -Infinity, i = 0
    const take = (t: number) => { const fresh = t > last; last = t; return fresh }
    if (from < limit) { last = from; yield from }
    for (;;) {
      let next = i < ends.length ? ends[i]! : Infinity
      for (const r of resets) if (r.at !== null && r.at < next) next = r.at
      if (next === Infinity || next >= limit) return
      if (i < ends.length && ends[i] === next) i++
      for (const r of resets) {
        if (r.at === next) r.at = r.window.every === null ? null : next + r.window.every
        if (r.at !== null && r.at >= from + HORIZON_MINUTES) r.at = null
      }
      if (take(next)) yield next
    }
  }

  /** Whether the machine has [needs] free over [span]: the most in use at once is at its start or at another task's. */
  private machineFits(machine: Machine, needs: Resources, span: Span): boolean {
    const uses = (this.machineUse.get(machine.id) ?? []).filter(u => u.start < span.end && u.end > span.start)
    for (const at of [span.start, ...uses.map(u => u.start).filter(s => s > span.start)]) {
      const busy = uses.filter(u => u.start <= at && u.end > at)
      const cpu = busy.reduce((sum, u) => sum + u.needs.cpu, needs.cpu)
      const ram = busy.reduce((sum, u) => sum + u.needs.ram, needs.ram)
      const disk = busy.reduce((sum, u) => sum + u.needs.disk, needs.disk)
      if (cpu > machine.capacity.cpu + 1e-9 || ram > machine.capacity.ram || disk > machine.capacity.disk) return false
    }
    return true
  }

  private modelFits(mode: Mode, span: Span): boolean {
    if (mode.limit === undefined) return true
    const uses = (this.modelUse.get(mode.model) ?? []).filter(u => u.start < span.end && u.end > span.start)
    for (const at of [span.start, ...uses.map(u => u.start).filter(s => s > span.start)]) {
      if (uses.filter(u => u.start <= at && u.end > at).length + 1 > mode.limit) return false
    }
    return true
  }

  private filesFree(task: Task, builder: string, span: Span): boolean {
    return task.files.every(file => (this.fileUse.get(file) ?? []).every(u => u.builder === builder || u.end <= span.start || u.start >= span.end))
  }

  private quotaFits(account: Account | undefined, task: Task, mode: Mode, span: Span): boolean {
    if (!account) return true
    return account.windows.every(window => {
      const used = this.spent.get(`${account.id}\n${window.name}`)
      for (const [index, share] of shares(window, task, mode, span)) {
        const room = Math.max(0, (index === 0 ? window.left : 100) - account.reserve)
        if ((used?.get(index) ?? 0) + share > room + 1e-9) return false
      }
      return true
    })
  }
}

/** The first reset of [window] after [from] that the plan considers: after [now], and none for a window with one reset
 *  that has passed. */
function firstReset(window: QuotaWindow, from: number, now: number): number | null {
  // A reset reported in the past gives none, as the list before this generator gave none.
  if (window.resetsAt <= now) return null
  if (window.resetsAt > from) return window.resetsAt > now && window.resetsAt < from + HORIZON_MINUTES ? window.resetsAt : null
  if (window.every === null) return null
  const at = window.resetsAt + (Math.floor((from - window.resetsAt) / window.every) + 1) * window.every
  return at > now && at < from + HORIZON_MINUTES ? at : null
}

/** What [task] spends of [window] in each of the window's spans it runs in, by the span's index from now (0 the current):
 *  its percent at policy cost 2, scaled by the model's cost as the route scales it, shared by minutes. */
function shares(window: QuotaWindow, task: Task, mode: Mode, span: Span): Map<number, number> {
  const spend = (task.spend[window.name] ?? 0) * mode.cost / 2
  const result = new Map<number, number>()
  if (spend <= 0) return result
  const length = span.end - span.start
  let at = span.start
  while (at < span.end) {
    const index = windowIndex(window, at)
    const end = Math.min(span.end, windowEnd(window, index))
    result.set(index, (result.get(index) ?? 0) + spend * (end - at) / length)
    at = end
  }
  return result
}

/** Which of [window]'s spans [minute] falls in: 0 until its next reset, then one more at each reset after. */
export function windowIndex(window: QuotaWindow, minute: number): number {
  if (minute < window.resetsAt) return 0
  if (window.every === null) return 1
  return 1 + Math.floor((minute - window.resetsAt) / window.every)
}

function windowEnd(window: QuotaWindow, index: number): number {
  if (index === 0) return window.resetsAt
  if (window.every === null) return Infinity
  return window.resetsAt + index * window.every
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list) list.push(value); else map.set(key, [value])
}

/** The plan [choice] gives: each task in its order, at its earliest start on its builder and mode. A task whose dependencies
 *  are not placed yet waits until they are, so any order gives a plan that keeps them. */
export function schedule(problem: Problem, choice: Choice): Plan {
  const timeline = new Timeline(problem)
  const tasks = new Map(problem.tasks.map(t => [t.id, t]))
  const unplaced: Plan['unplaced'] = []
  let waiting = choice.order.filter(id => tasks.has(id))
  while (waiting.length) {
    const next: string[] = []
    let progress = false
    for (const id of waiting) {
      const task = tasks.get(id)!
      if (task.deps.some(dep => !timeline.placed.has(dep) && !unplaced.some(u => u.task === dep))) { next.push(id); continue }
      const lost = task.deps.find(dep => unplaced.some(u => u.task === dep))
      if (lost) { unplaced.push({ task: id, why: `it waits on ${lost}, which has no room` }); progress = true; continue }
      const span = timeline.earliest(task, choice.builder[id] ?? '', choice.mode[id] ?? 0)
      if ('why' in span) unplaced.push({ task: id, why: span.why })
      else timeline.place(task, choice.builder[id]!, choice.mode[id] ?? 0, span)
      progress = true
    }
    if (!progress) {
      // A cycle of dependencies: none of them can ever start.
      for (const id of next) unplaced.push({ task: id, why: 'its dependencies wait on each other' })
      break
    }
    waiting = next
  }
  return score(problem, [...timeline.placed.values()].map(({ family: _family, ...p }) => p), unplaced)
}

/** The plan's score, lower is better: by the problem's objective, then cost, plus what moving queued work and leaving tasks
 *  out costs. */
export function score(problem: Problem, placements: Placement[], unplaced: Plan['unplaced']): Plan {
  const tasks = new Map(problem.tasks.map(t => [t.id, t]))
  const builders = new Map(problem.builders.map(b => [b.id, b]))
  let makespan = problem.now, cost = 0, weighted = 0, switched = 0
  for (const p of placements) {
    const task = tasks.get(p.task)!, mode = builders.get(p.builder)!.modes[p.mode]!
    makespan = Math.max(makespan, p.end)
    cost += mode.cost * (p.end - p.start)
    weighted += task.weight * (p.end - problem.now)
    if (task.queuedOn && task.queuedOn !== p.builder) switched++
  }
  const main = problem.objective === 'makespan' ? (makespan - problem.now) * 1e6 : weighted * 1e3
  const total = main + cost + switched * (problem.switchCost ?? 15) * 1e3 + unplaced.length * UNPLACED
  return { placements, unplaced, score: total, makespan, cost }
}
