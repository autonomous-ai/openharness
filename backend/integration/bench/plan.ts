import { activeCount, WORKER_ACTIONS, type BenchConfig, type WorkerAction } from './config.js'
import { random, schedule, type Random } from './random.js'

export interface WorkerPlan {
  index: number
  machine: number
  /** The group whose work it holds during the load. */
  activeGroup: number
  /** The groups it finished during setup. */
  doneGroups: number[]
  actions: Array<{ at: number; op: WorkerAction }>
  /** When it takes a terminal turn: a prompt, then its answer. */
  turns: number[]
}

export interface Plan {
  doneGroups: number[]
  workers: WorkerPlan[]
  lead: Array<{ at: number; worker: number }>
  machines: Array<{ index: number; observations: number[]; deliveryPasses: number[] }>
  readers: Array<{ kind: 'desktop' | 'host'; index: number; polls: number[] }>
}

function weighted(rng: Random, mix: BenchConfig['mix']): WorkerAction {
  const actions = WORKER_ACTIONS.filter(a => mix[a] > 0)
  let roll = rng.next() * actions.reduce((sum, a) => sum + mix[a], 0)
  for (const action of actions) if ((roll -= mix[action]) < 0) return action
  return actions[actions.length - 1]!
}

/** A steady poller or reporter: a seeded first time within one interval, then exactly every interval. */
function steady(rng: Random, everyMs: number, durationMs: number): number[] {
  return schedule(rng, { meanMs: everyMs, durationMs, offsetMs: Math.floor(rng.next() * everyMs), jitter: false })
}

/** Everything the load will do and when, from the seed alone, so two runs do the same work in the same order. */
export function plan(config: BenchConfig): Plan {
  const { seed, durationMs, every } = config
  const workerCount = activeCount(config), done = config.groups - workerCount
  const doneGroups = Array.from({ length: done }, (_, i) => i)
  const workers = Array.from({ length: workerCount }, (_, index): WorkerPlan => {
    const rng = random(seed, `worker-${index}`)
    const actions = schedule(rng, { meanMs: every.workerPostMs, durationMs, offsetMs: Math.floor(rng.next() * every.workerPostMs) })
      .map(at => ({ at, op: weighted(rng, config.mix) }))
    const turns = schedule(rng, { meanMs: every.nativeTurnMs, durationMs, offsetMs: Math.floor(rng.next() * every.nativeTurnMs) })
    return { index, machine: index % config.machines, activeGroup: done + index,
      doneGroups: doneGroups.filter(g => g % workerCount === index), actions, turns }
  })
  const leadRng = random(seed, 'lead')
  const lead = schedule(leadRng, { meanMs: every.leadSendMs, durationMs, offsetMs: Math.floor(leadRng.next() * every.leadSendMs) })
    .map(at => ({ at, worker: Math.floor(leadRng.next() * workerCount) }))
  const machines = Array.from({ length: config.machines }, (_, index) => {
    const rng = random(seed, `machine-${index}`)
    return { index, observations: steady(rng, every.observeMs, durationMs), deliveryPasses: steady(rng, every.deliveryPassMs, durationMs) }
  })
  const readers = [
    ...Array.from({ length: config.desktopReaders }, (_, index) => ({ kind: 'desktop' as const, index,
      polls: steady(random(seed, `desktop-${index}`), every.desktopPollMs, durationMs) })),
    ...Array.from({ length: config.hostReaders }, (_, index) => ({ kind: 'host' as const, index,
      polls: steady(random(seed, `host-${index}`), every.hostTickMs, durationMs) })),
  ]
  return { doneGroups, workers, lead, machines, readers }
}
