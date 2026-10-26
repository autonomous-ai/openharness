import { createHash } from 'node:crypto'
import { activeCount, WORKER_ACTIONS, type BenchConfig, type WorkerAction } from './config.js'
import { random, schedule, type Random } from './random.js'

export interface WorkerPlan {
  index: number
  machine: number
  /** Its active groups. It holds the task of the first; an agent holds one active task at a time (AGENT_BUSY). */
  groups: number[]
  /** The groups it finished during setup. */
  doneGroups: number[]
  /** Status and checks go to its first group; messages to any of its groups. */
  actions: Array<{ at: number; op: WorkerAction; group: number }>
  /** When it takes a terminal turn: a prompt, then its answer. */
  turns: number[]
}

export interface Plan {
  doneGroups: number[]
  workers: WorkerPlan[]
  lead: Array<{ at: number; worker: number; group: number }>
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
  const done = config.groups - activeCount(config), workerCount = config.workers
  const doneGroups = Array.from({ length: done }, (_, i) => i)
  const activeGroups = Array.from({ length: activeCount(config) }, (_, i) => done + i)
  const workers = Array.from({ length: workerCount }, (_, index): WorkerPlan => {
    // Group choices have their own stream, so a worker's timing and mix stay the same whatever its number of groups.
    const rng = random(seed, `worker-${index}`), where = random(seed, `worker-groups-${index}`)
    const groups = activeGroups.filter((_, i) => i % workerCount === index)
    const actions = schedule(rng, { meanMs: every.workerPostMs, durationMs, offsetMs: Math.floor(rng.next() * every.workerPostMs) })
      .map(at => {
        const op = weighted(rng, config.mix)
        return { at, op, group: op === 'message.send' && groups.length > 1 ? where.pick(groups) : groups[0]! }
      })
    const turns = schedule(rng, { meanMs: every.nativeTurnMs, durationMs, offsetMs: Math.floor(rng.next() * every.nativeTurnMs) })
    return { index, machine: index % config.machines, groups, doneGroups: doneGroups.filter(g => g % workerCount === index), actions, turns }
  })
  const crossGroup = config.lane === 'cross-group'
  const leadRng = random(seed, 'lead'), leadWhere = random(seed, 'lead-groups')
  const lead = crossGroup ? [] : schedule(leadRng, { meanMs: every.leadSendMs, durationMs, offsetMs: Math.floor(leadRng.next() * every.leadSendMs) })
    .map(at => {
      const worker = Math.floor(leadRng.next() * workerCount), groups = workers[worker]!.groups
      return { at, worker, group: groups.length > 1 ? leadWhere.pick(groups) : groups[0]! }
    })
  const machines = Array.from({ length: config.machines }, (_, index) => {
    const rng = random(seed, `machine-${index}`)
    const observations = steady(rng, every.observeMs, durationMs), deliveryPasses = steady(rng, every.deliveryPassMs, durationMs)
    return { index, observations, deliveryPasses: crossGroup ? [] : deliveryPasses }
  })
  const readers = [
    ...Array.from({ length: config.desktopReaders }, (_, index) => ({ kind: 'desktop' as const, index,
      polls: steady(random(seed, `desktop-${index}`), every.desktopPollMs, durationMs) })),
    ...Array.from({ length: config.hostReaders }, (_, index) => ({ kind: 'host' as const, index,
      polls: steady(random(seed, `host-${index}`), every.hostTickMs, durationMs) })),
  ]
  return { doneGroups, workers, lead, machines, readers }
}

/** A fingerprint of the work a plan holds: equal fingerprints in two reports mean both runs were asked to do the same. */
export function planDigest(p: Plan): string {
  return createHash('sha256').update(JSON.stringify(p)).digest('hex')
}
