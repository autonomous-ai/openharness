import type { ActivityState } from '../turnActivity.js'

/** Idle with no input for this long before an agent may be moved to a new host. */
export const QUIET_MS = 300_000

interface Entry {
  idleSince: number | null
  lastInput: number | null
}

/**
 * Tracks how long an agent has been idle and untouched. Moving an engine
 * restarts it, so the mover only acts on agents nobody is using.
 */
export class QuietClock {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly deps: { now: () => number }) {}

  private entry(agentId: string): Entry {
    let e = this.entries.get(agentId)
    if (!e) {
      e = { idleSince: null, lastInput: null }
      this.entries.set(agentId, e)
    }
    return e
  }

  noteInput(agentId: string): void {
    this.entry(agentId).lastInput = this.deps.now()
  }

  noteActivity(agentId: string, state: ActivityState): void {
    const e = this.entry(agentId)
    if (state === 'idle') {
      // Only the first idle after anything else starts the clock; polling
      // every tick must not keep restarting it.
      if (e.idleSince === null) e.idleSince = this.deps.now()
    } else {
      e.idleSince = null
    }
  }

  quietFor(agentId: string): number {
    const e = this.entries.get(agentId)
    if (!e || e.idleSince === null) return 0
    return Math.max(0, this.deps.now() - Math.max(e.idleSince, e.lastInput ?? 0))
  }

  forget(agentId: string): void {
    this.entries.delete(agentId)
  }
}
