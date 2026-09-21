/**
 * Bookkeeping for session attaches — the reads of an agent's whole history that rebuild its live
 * normalizer (cli.ts `attachSessionNow`). Two jobs, both born of the same incident: a daemon whose
 * boot sat on ONE agent's store for good, with nothing in any log to say which.
 *
 *  - ONE attach per session at a time. Boot hydrates every agent in the background, and the first
 *    reconcile pass, a hook, or a cursor discovery can ask for the same session while that is still
 *    running. A second fold on top of the first is the duplicate-turn class of bug (a turn opened,
 *    closed after 44ms and opened again), so a plain attach JOINS the one in flight, and a `reset`
 *    waits for it and then folds afresh.
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
  /** After this long, `onSlow` is told once about the attach. */
  slowMs?: number
  onSlow?: (subject: AttachSubject<E>, elapsedMs: number) => void
  now?: () => number
}

const DEFAULT_SLOW_MS = 15_000

export class AttachTracker<E> {
  private readonly inFlight = new Map<string, { run: Promise<boolean>; subject: AttachSubject<E>; since: number }>()
  private readonly slowMs: number
  private readonly onSlow?: (subject: AttachSubject<E>, elapsedMs: number) => void
  private readonly now: () => number

  constructor(options: AttachTrackerOptions<E> = {}) {
    this.slowMs = options.slowMs ?? DEFAULT_SLOW_MS
    this.onSlow = options.onSlow
    this.now = options.now ?? Date.now
  }

  /**
   * Run `start` for this session — unless one is already running, in which case a plain attach
   * returns THAT one's result and `start` is never called; a `reset` waits for it, then runs `start`.
   */
  async attach(session: AttachSubject<E>, reset: boolean, start: () => Promise<boolean>): Promise<boolean> {
    // A loop, not an if: two resets waiting on the same attach would otherwise both start at once.
    for (let pending = this.inFlight.get(session.sessionId); pending; pending = this.inFlight.get(session.sessionId)) {
      if (!reset) return pending.run
      await pending.run.catch(() => false)
    }
    const since = this.now()
    const slow = setTimeout(() => this.onSlow?.(session, this.now() - since), this.slowMs)
    slow.unref?.()
    // A `start` that throws before it returns a promise must still clear the timer and the slot.
    let started: Promise<boolean>
    try { started = start() } catch (err) { started = Promise.reject(err) }
    const run = started.finally(() => {
      clearTimeout(slow)
      if (this.inFlight.get(session.sessionId)?.run === run) this.inFlight.delete(session.sessionId)
    })
    this.inFlight.set(session.sessionId, { run, subject: session, since })
    return run
  }

  /** What is being read right now, longest-running first. */
  attaching(): Array<AttachInFlight<E>> {
    const now = this.now()
    return [...this.inFlight.values()]
      .map(({ subject, since }) => ({
        sessionId: subject.sessionId, agentId: subject.agentId, engine: subject.engine, sinceMs: now - since,
      }))
      .sort((a, b) => b.sinceMs - a.sinceMs)
  }
}

/**
 * `fn` over every item, at most `limit` at a time, in order of the list. A rejection is the caller's
 * to catch inside `fn`; here it would stop that worker's share of the list, which is not what a boot
 * wants, so `fn` is expected to swallow its own.
 */
export async function forEachBounded<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, worker))
}
