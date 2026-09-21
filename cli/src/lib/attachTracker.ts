/**
 * Bookkeeping for session attaches — the reads of an agent's whole history that rebuild its live
 * normalizer (cli.ts `attachSessionNow`). Two jobs, both born of the same incident: a daemon whose
 * boot sat on ONE agent's store for good, with nothing in any log to say which.
 *
 *  - ONE attach per session at a time. The first reconcile pass after a boot starts one for every
 *    agent it reactivates, and a hook or a cursor discovery can ask for the same session while that
 *    is still running. A second fold on top of the first is the duplicate-turn class of bug (a turn
 *    opened, closed after 44ms and opened again), so a plain attach JOINS the one in flight, and a
 *    `reset` waits for it and then folds afresh.
 *  - A FEW sessions at a time. Each attach is a tmux probe, a `ps` over the whole machine and the
 *    agent's entire transcript or store; a boot with twenty agents must not start twenty at once.
 *  - Saying what the daemon is busy with. `/api/status` lists the attaches in flight, and one that
 *    runs long is logged by name.
 */

export interface AttachSubject<E> {
  sessionId: string
  agentId: string
  engine: E
}

export interface AttachInFlight<E> {
  sessionId: string
  agentId: string
  engine: E
  /** How long this attach has been running. */
  sinceMs: number
}

export interface AttachTrackerOptions<E> {
  /** How many attaches may run at once; the rest wait their turn, in the order they asked. */
  concurrency?: number
  /** After this long RUNNING (waiting for a slot does not count), `onSlow` is told once about the attach. */
  slowMs?: number
  onSlow?: (subject: AttachSubject<E>, elapsedMs: number) => void
  now?: () => number
}

const DEFAULT_SLOW_MS = 15_000
const DEFAULT_CONCURRENCY = 4

export class AttachTracker<E> {
  /** Every attach that has been asked for and not finished — waiting for a slot or running. */
  private readonly inFlight = new Map<string, { run: Promise<boolean>; subject: AttachSubject<E>; since: number | null }>()
  private readonly waiting: Array<() => void> = []
  private running = 0
  private readonly concurrency: number
  private readonly slowMs: number
  private readonly onSlow?: (subject: AttachSubject<E>, elapsedMs: number) => void
  private readonly now: () => number

  constructor(options: AttachTrackerOptions<E> = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
    this.slowMs = options.slowMs ?? DEFAULT_SLOW_MS
    this.onSlow = options.onSlow
    this.now = options.now ?? Date.now
  }

  /**
   * Run `start` for this session — unless one is already in flight, in which case a plain attach
   * returns THAT one's result and `start` is never called; a `reset` waits for it, then runs `start`.
   * Either way `start` runs only once a slot is free.
   */
  async attach(session: AttachSubject<E>, reset: boolean, start: () => Promise<boolean>): Promise<boolean> {
    // A loop, not an if: two resets waiting on the same attach would otherwise both start at once.
    for (let pending = this.inFlight.get(session.sessionId); pending; pending = this.inFlight.get(session.sessionId)) {
      if (!reset) return pending.run
      await pending.run.catch(() => false)
    }
    const entry = { run: Promise.resolve(false), subject: session, since: null as number | null }
    entry.run = this.runWhenFree(entry, start).finally(() => {
      if (this.inFlight.get(session.sessionId) === entry) this.inFlight.delete(session.sessionId)
    })
    this.inFlight.set(session.sessionId, entry)
    return entry.run
  }

  private async runWhenFree(
    entry: { subject: AttachSubject<E>; since: number | null },
    start: () => Promise<boolean>,
  ): Promise<boolean> {
    // A finishing attach hands its slot straight to the next in line (below) rather than freeing it:
    // a newcomer arriving in that gap would otherwise slip in ahead of the queue and push it past `concurrency`.
    if (this.running < this.concurrency) this.running++
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    entry.since = this.now()
    const since = entry.since
    const slow = setTimeout(() => this.onSlow?.(entry.subject, this.now() - since), this.slowMs)
    slow.unref?.()
    try {
      // A `start` that throws before it returns a promise is a failed attach, not a lost slot.
      return await start()
    } finally {
      clearTimeout(slow)
      const next = this.waiting.shift()
      if (next) next()
      else this.running--
    }
  }

  /** What is being read right now, longest-running first. Attaches still waiting for a slot are not here. */
  attaching(): Array<AttachInFlight<E>> {
    const now = this.now()
    return [...this.inFlight.values()]
      .filter((entry): entry is typeof entry & { since: number } => entry.since !== null)
      .map(({ subject, since }) => ({
        sessionId: subject.sessionId, agentId: subject.agentId, engine: subject.engine, sinceMs: now - since,
      }))
      .sort((a, b) => b.sinceMs - a.sinceMs)
  }

  /** How many attaches are waiting for a slot. */
  queued(): number {
    return this.waiting.length
  }
}
