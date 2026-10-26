import { createHash } from 'node:crypto'

/** A seeded stream: the same seed and label give the same numbers, so two runs of the benchmark do the same work. */
export interface Random {
  /** In [0, 1). */
  next(): number
  pick<T>(items: readonly T[]): T
}

/** mulberry32, seeded from the run's seed and the actor's label, so each actor's choices do not depend on another's. */
export function random(seed: number, label: string): Random {
  let state = createHash('sha256').update(`${seed}:${label}`).digest().readUInt32LE(0)
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, pick: items => items[Math.floor(next() * items.length)]! }
}

export interface ScheduleOptions {
  meanMs: number
  durationMs: number
  /** When the first event happens, so actors with one cadence do not all fire at once. */
  offsetMs: number
  /** Gaps between half and one and a half times the mean (the default), or exactly the mean. */
  jitter?: boolean
}

/** When an actor acts, in ms from the start of the load. Planned up front, so a slow reply never changes the plan. */
export function schedule(rng: Random, { meanMs, durationMs, offsetMs, jitter = true }: ScheduleOptions): number[] {
  const times: number[] = []
  for (let at = offsetMs; at < durationMs; at += jitter ? Math.round(meanMs * (0.5 + rng.next())) : meanMs) times.push(at)
  return times
}

const VOCABULARY = ['build', 'review', 'merge', 'check', 'agent', 'group', 'swarm', 'state', 'part', 'store', 'cursor', 'poll',
  'machine', 'delivery', 'native', 'turn', 'brief', 'result', 'evidence', 'test', 'branch', 'commit', 'fix', 'plan']

/** Text of exactly [length] characters, so seeded briefs and results give the state a realistic size. */
export function words(rng: Random, length: number): string {
  let text = ''
  while (text.length < length) text += `${rng.pick(VOCABULARY)} `
  return text.slice(0, length)
}
