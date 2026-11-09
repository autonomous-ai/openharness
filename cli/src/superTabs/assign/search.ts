/**
 * The best choice for a problem (model.ts): a strong first plan, then local search that keeps the best plan it meets.
 *
 * The first plan is list scheduling: tasks by weight, then by how much work waits behind them (the critical path, which
 * bounds how soon everything can end), then by when they are ready; each goes to the builder and model where it ends
 * soonest, the cheaper on a tie. Local search then moves one thing at a time (a task to another builder or model, with or
 * without a new place in the order, two tasks' places, a task to another place, two tasks' builders) and keeps a move by
 * simulated annealing: always when the plan is better, sometimes when it is a little worse, less often as it goes on, so it
 * leaves a local best. It runs as four chains, the first from the list plan and the others from list plans of shuffled
 * priorities, and keeps the best plan any of them met: on small problems one chain from the list plan stayed at it when
 * the best plan needed three moves at once (seed 2 of the brute-force check). schedule.ts builds every plan it compares,
 * so no plan it keeps breaks a constraint.
 *
 * Seeded and bounded: the same problem and seed give the same plan, within an iteration count and a time budget.
 */
import type { Choice, Plan, Problem, Task } from './model.js'
import { optionsOf, schedule, Timeline } from './schedule.js'

export interface SolveOptions {
  /** Moves tried at most, and milliseconds at most. */
  iterations?: number
  budgetMs?: number
  seed?: number
  /** The last plan's choice: the search starts from it, so a new plan differs from the last only where it gains. */
  start?: Choice
  now?: () => number
}

export interface Solved { plan: Plan; choice: Choice; iterations: number; first: Plan }

type Option = { builder: string; mode: number }
/** Independent annealing chains the iterations are shared among. */
const CHAINS = 4

export function solve(problem: Problem, options: SolveOptions = {}): Solved {
  const clock = options.now ?? Date.now
  const deadline = clock() + (options.budgetMs ?? 1_000)
  const random = mulberry32(options.seed ?? 1)
  const choices = new Map<string, Option[]>()
  for (const task of problem.tasks) {
    const found = optionsOf(problem, task)
    if (typeof found !== 'string') choices.set(task.id, found)
  }
  const greedy = firstChoice(problem, choices)
  const first = schedule(problem, greedy)
  let start = options.start ? fromLast(problem, options.start, greedy, choices) : greedy
  if (options.start && schedule(problem, start).score > first.score) start = greedy
  let best = start, bestPlan = schedule(problem, start)
  const iterations = options.iterations ?? 4_000
  const movable = problem.tasks.filter(t => choices.has(t.id)).map(t => t.id)
  let tried = 0
  for (let chain = 0; chain < CHAINS && movable.length; chain++) {
    let current = chain === 0 ? start : firstChoice(problem, choices, random)
    let currentPlan = schedule(problem, current)
    if (currentPlan.score < bestPlan.score) { best = current; bestPlan = currentPlan }
    const length = Math.ceil(iterations / CHAINS)
    for (let step = 0; step < length && tried < iterations && clock() < deadline; step++, tried++) {
      const next = move(current, movable, choices, random)
      const plan = schedule(problem, next)
      const temperature = 0.05 * Math.pow(0.01, step / length)
      const worse = (plan.score - currentPlan.score) / Math.max(1, Math.abs(currentPlan.score))
      if (worse <= 0 || random() < Math.exp(-worse / temperature)) {
        current = next
        currentPlan = plan
        if (plan.score < bestPlan.score) { best = next; bestPlan = plan }
      }
    }
  }
  return { plan: bestPlan, choice: best, iterations: tried, first }
}

/** List scheduling: in priority order, each task where it ends soonest given those before it, the cheaper on a tie. With
 *  [random], the priorities are shuffled a little first, for another chain's start. */
export function firstChoice(problem: Problem, choices: Map<string, Option[]>, random?: () => number): Choice {
  const order = priorityOrder(problem)
  if (random) for (let i = order.length - 1; i > 0; i--) {
    if (random() < 0.5) continue
    const j = Math.max(0, i - 1 - Math.floor(random() * 3))
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  const timeline = new Timeline(problem)
  const tasks = new Map(problem.tasks.map(t => [t.id, t]))
  const builders = new Map(problem.builders.map(b => [b.id, b]))
  const choice: Choice = { order, builder: {}, mode: {} }
  for (const id of order) {
    const task = tasks.get(id)!
    let best: { option: Option; end: number; cost: number; span: { start: number; end: number } } | null = null
    for (const option of choices.get(id) ?? []) {
      const span = timeline.earliest(task, option.builder, option.mode)
      if ('why' in span) continue
      const mode = builders.get(option.builder)!.modes[option.mode]!
      const cost = mode.cost * (span.end - span.start) + (task.queuedOn && task.queuedOn !== option.builder ? (problem.switchCost ?? 15) : 0)
      if (!best || span.end < best.end || (span.end === best.end && cost < best.cost)) best = { option, end: span.end, cost, span }
    }
    const pick = best?.option ?? choices.get(id)?.[0]
    if (pick) { choice.builder[id] = pick.builder; choice.mode[id] = pick.mode }
    if (best) timeline.place(task, best.option.builder, best.option.mode, best.span)
  }
  return choice
}

/** Tasks by weight, then by the longest chain of work waiting on them, then by when they are ready, then by id. */
export function priorityOrder(problem: Problem): string[] {
  const tasks = new Map(problem.tasks.map(t => [t.id, t]))
  const after = new Map<string, string[]>()
  for (const task of problem.tasks) for (const dep of task.deps) after.set(dep, [...after.get(dep) ?? [], task.id])
  const tail = new Map<string, number>()
  const tailOf = (id: string, seen = new Set<string>()): number => {
    const known = tail.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return 0
    seen.add(id)
    const task = tasks.get(id)
    const value = (task?.minutes ?? 0) + Math.max(0, ...(after.get(id) ?? []).map(next => tailOf(next, seen)))
    tail.set(id, value)
    return value
  }
  return [...problem.tasks].sort((a, b) => b.weight - a.weight || tailOf(b.id) - tailOf(a.id) || a.ready - b.ready || a.id.localeCompare(b.id))
    .map(t => t.id)
}

/** The last plan's choice for the tasks still here, with new tasks placed as the first plan places them. */
function fromLast(problem: Problem, last: Choice, greedy: Choice, choices: Map<string, Option[]>): Choice {
  const here = new Set(problem.tasks.map(t => t.id))
  const order = [...last.order.filter(id => here.has(id)), ...greedy.order.filter(id => !last.order.includes(id))]
  const choice: Choice = { order, builder: {}, mode: {} }
  for (const id of order) {
    const kept = choices.get(id)?.some(o => o.builder === last.builder[id] && o.mode === last.mode[id])
    choice.builder[id] = kept ? last.builder[id]! : greedy.builder[id]!
    choice.mode[id] = kept ? last.mode[id] ?? 0 : greedy.mode[id] ?? 0
  }
  return choice
}

/** One random step from [choice]. */
function move(choice: Choice, movable: string[], choices: Map<string, Option[]>, random: () => number): Choice {
  const next: Choice = { order: [...choice.order], builder: { ...choice.builder }, mode: { ...choice.mode } }
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!
  const roll = random()
  if (roll < 0.5) {
    // A task to another builder or model, and half the time to another place in the order too: moving work to a builder
    // that is free sooner often needs it placed earlier as well.
    const id = pick(movable)
    const option = pick(choices.get(id)!)
    next.builder[id] = option.builder
    next.mode[id] = option.mode
    if (roll < 0.25) {
      next.order.splice(next.order.indexOf(id), 1)
      next.order.splice(Math.floor(random() * (next.order.length + 1)), 0, id)
    }
  } else if (roll < 0.7) {
    const i = Math.floor(random() * next.order.length)
    const j = Math.min(next.order.length - 1, Math.max(0, i + Math.floor(random() * 11) - 5))
    ;[next.order[i], next.order[j]] = [next.order[j]!, next.order[i]!]
  } else if (roll < 0.85) {
    const from = Math.floor(random() * next.order.length)
    const [id] = next.order.splice(from, 1)
    next.order.splice(Math.floor(random() * (next.order.length + 1)), 0, id!)
  } else {
    const a = pick(movable), b = pick(movable)
    const aOn = choices.get(a)!.find(o => o.builder === choice.builder[b])
    const bOn = choices.get(b)!.find(o => o.builder === choice.builder[a])
    if (aOn && bOn) {
      next.builder[a] = aOn.builder; next.mode[a] = aOn.mode
      next.builder[b] = bOn.builder; next.mode[b] = bOn.mode
    }
  }
  return next
}

/** A small seeded generator (mulberry32): the same seed gives the same plan. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A plan's lower bound on when everything can end: the longest chain of dependencies at the fastest speed any builder
 *  has. A plan that reaches it has the least makespan there is. */
export function criticalPath(problem: Problem): number {
  const fastest = Math.max(...problem.builders.flatMap(b => b.modes.map(m => m.speed)), 1)
  const tasks = new Map(problem.tasks.map(t => [t.id, t]))
  const memo = new Map<string, number>()
  const end = (task: Task, seen = new Set<string>()): number => {
    const known = memo.get(task.id)
    if (known !== undefined) return known
    if (seen.has(task.id)) return 0
    seen.add(task.id)
    const start = Math.max(problem.now, task.ready, ...task.deps.map(d => tasks.get(d)).filter((d): d is Task => !!d).map(d => end(d, seen)))
    const value = start + Math.ceil(task.minutes / fastest)
    memo.set(task.id, value)
    return value
  }
  return Math.max(problem.now, ...problem.tasks.map(t => end(t)))
}
