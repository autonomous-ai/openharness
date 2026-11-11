import { createHash } from 'node:crypto'
import type { BenchConfig } from './config.js'
import { random, schedule, type Random } from './random.js'

export interface AgentPlan {
  index: number
  /** Its machine, whose owner is its person. */
  machine: number
  /** The project whose channel it posts in: the one it leads, for a PM, else the projects in turn. */
  project: number
  /** It leads its project (the first agent of each). */
  pm: boolean
  /** When it posts in its project's channel; a Member's post names its PM, which waits as a delivery. */
  posts: number[]
  /** When its person writes in their 1:1 chat with it; it answers there. */
  turns: number[]
}

export interface Plan {
  agents: AgentPlan[]
  machines: Array<{ index: number; observations: number[]; deliveryPasses: number[] }>
  readers: Array<{ kind: 'desktop' | 'host'; index: number; polls: number[] }>
}

/** A steady poller or reporter: a seeded first time within one interval, then exactly every interval. */
function steady(rng: Random, everyMs: number, durationMs: number): number[] {
  return schedule(rng, { meanMs: everyMs, durationMs, offsetMs: Math.floor(rng.next() * everyMs), jitter: false })
}

/** Everything the load will do and when, from the seed alone, so two runs do the same work in the same order. */
export function plan(config: BenchConfig): Plan {
  const { seed, durationMs, every } = config
  const agents = Array.from({ length: config.agents }, (_, index): AgentPlan => {
    const rng = random(seed, `agent-${index}`)
    const posts = schedule(rng, { meanMs: every.channelPostMs, durationMs, offsetMs: Math.floor(rng.next() * every.channelPostMs) })
    const turns = schedule(rng, { meanMs: every.chatTurnMs, durationMs, offsetMs: Math.floor(rng.next() * every.chatTurnMs) })
    return { index, machine: index % config.machines, project: index % config.projects, pm: index < config.projects, posts, turns }
  })
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
  return { agents, machines, readers }
}

/** A fingerprint of the work a plan holds: equal fingerprints in two reports mean both runs were asked to do the same. */
export function planDigest(p: Plan): string {
  return createHash('sha256').update(JSON.stringify(p)).digest('hex')
}
