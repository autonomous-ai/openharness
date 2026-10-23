/**
 * Holds what reaches an agent while it changes host: its engine stops in the old pane and starts in a new one,
 * and input written in between would land in a pane that is going away. Nothing is refused or dropped: each
 * write waits here, in the order it arrived, and is delivered once the row points at the pane that stays (the
 * new one, or the old one when the move fell back).
 *
 * Only writes wait. A stream open is never held: a held open would stall every later frame of its connection
 * (frames are handled in order per connection), and the desktop gives up on an open after 4 s. It opens on the
 * pane the row names and is moved with the agent's other streams (`TerminalStreamManager.retarget`).
 */
interface Hold {
  queue: Array<() => Promise<void>>
  draining: boolean
  /** Whether input, a stream open or a message reached the agent during this hold: someone is using it. */
  touched: boolean
  /** Settles once the release that drains this hold has let the agent go. */
  done?: Promise<void>
}

export class MoveGate {
  private readonly holds = new Map<string, Hold>()

  /** Start holding [agentId]'s input. A second hold of an agent already held changes nothing. */
  hold(agentId: string): void {
    if (this.holds.has(agentId)) return
    this.holds.set(agentId, { queue: [], draining: false, touched: false })
  }

  /** True from `hold` until the last queued write after `release` has been delivered: a write that arrives
   *  while the queue drains must queue behind it, or it would overtake input typed before it. */
  holding(agentId: string): boolean {
    return this.holds.has(agentId)
  }

  /** Queue [deliver] behind what is already held for [agentId], and count the agent as in use. An agent not
   *  held is delivered at once. */
  enqueue(agentId: string, deliver: () => Promise<void>): void {
    const hold = this.holds.get(agentId)
    if (!hold) {
      void deliver().catch(() => { /* the deliverer reports its own failure */ })
      return
    }
    hold.touched = true
    hold.queue.push(deliver)
  }

  /** Count a held [agentId] as in use without queueing anything: a stream opened on it, or a write refused
   *  for now (one whose caller asks again). Nothing for an agent not held. */
  touch(agentId: string): void {
    const hold = this.holds.get(agentId)
    if (hold) hold.touched = true
  }

  /** Whether anything reached [agentId] during the current hold. False once it is let go: the next hold
   *  starts untouched. */
  touched(agentId: string): boolean {
    return this.holds.get(agentId)?.touched === true
  }

  /**
   * Deliver what was held, one write at a time in arrival order, then let [agentId] go. The mover calls this
   * after the row's runtime has switched (or fallen back) and its streams were retargeted, so each write
   * reaches the row's current pane when it runs. A write that fails is its deliverer's to report: the rest
   * still go. A second release while the first drains resolves at once; the first lets the agent go.
   */
  async release(agentId: string): Promise<void> {
    const hold = this.holds.get(agentId)
    if (!hold || hold.draining) return
    hold.draining = true
    let finished!: () => void
    hold.done = new Promise<void>((resolve) => { finished = resolve })
    for (let next = hold.queue.shift(); next; next = hold.queue.shift()) {
      try { await next() } catch { /* reported by the deliverer */ }
    }
    // No await between the empty queue and this: nothing can be queued that would then never run.
    this.holds.delete(agentId)
    finished()
  }

  /** The agents held now. */
  held(): string[] {
    return [...this.holds.keys()]
  }

  /**
   * Release every agent held, as `release` does each: what waits for it is written to the pane its row names now. For a
   * hand-over that cannot wait any longer for a move to finish (mover.ts `settleMovesForHandOver`): the connection the
   * deliveries are written through is about to close. Resolves once every agent is let go, a release already under way
   * (the move's own) included.
   */
  async releaseAll(): Promise<void> {
    await Promise.all([...this.holds].map(([agentId, hold]) => (hold.draining ? hold.done : this.release(agentId))))
  }
}

/** Longer than a move holds an agent (at most 75 s, moveAgent.ts), so a wait outlasts any hold that ends. */
export const HOLD_WAIT_MS = 90_000
const HOLD_POLL_MS = 100

/**
 * [acquire] (a control of the agent's pane, `acquireTerminalControl`), asked again once [agentId]'s move lets it go
 * when it was refused because a move holds it: the /model picker then waits out a move it never sees, rather than
 * answering BUSY. A refusal for any other reason is the answer at once. Nothing here touches the gate: [acquire] itself
 * counts a held agent as in use when it refuses it (lib/sessionInput.ts `acquireControl` calls `touch`), which cancels
 * a move that has not yet stopped the engine. Waits at most [boundMs].
 */
export async function acquireAfterHold<T>(gate: Pick<MoveGate, 'holding'>, agentId: string, acquire: () => T | null,
  boundMs = HOLD_WAIT_MS): Promise<T | null> {
  const first = acquire()
  if (first !== null || !gate.holding(agentId)) return first
  const deadline = Date.now() + boundMs
  while (gate.holding(agentId)) {
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, HOLD_POLL_MS))
  }
  return acquire()
}
