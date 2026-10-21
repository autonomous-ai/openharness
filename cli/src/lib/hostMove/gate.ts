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
    for (let next = hold.queue.shift(); next; next = hold.queue.shift()) {
      try { await next() } catch { /* reported by the deliverer */ }
    }
    // No await between the empty queue and this: nothing can be queued that would then never run.
    this.holds.delete(agentId)
  }
}
