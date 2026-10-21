/**
 * Holds what reaches an agent while it changes host: its engine stops in the old pane and starts in a new one,
 * and input written in between would land in a pane that is going away. Nothing is refused or dropped: each
 * write waits here, in the order it arrived, and is delivered once the row points at the pane that stays (the
 * new one, or the old one when the move fell back).
 */
interface Hold {
  queue: Array<() => Promise<void>>
  draining: boolean
  opened: Promise<void>
  open: () => void
}

export class MoveGate {
  private readonly holds = new Map<string, Hold>()

  /** Start holding [agentId]'s input. A second hold of an agent already held changes nothing. */
  hold(agentId: string): void {
    if (this.holds.has(agentId)) return
    let open!: () => void
    const opened = new Promise<void>((resolve) => { open = resolve })
    this.holds.set(agentId, { queue: [], draining: false, opened, open })
  }

  /** True from `hold` until the last queued write after `release` has been delivered: a write that arrives
   *  while the queue drains must queue behind it, or it would overtake input typed before it. */
  holding(agentId: string): boolean {
    return this.holds.has(agentId)
  }

  /** Queue [deliver] behind what is already held for [agentId]. An agent not held is delivered at once. */
  enqueue(agentId: string, deliver: () => Promise<void>): void {
    const hold = this.holds.get(agentId)
    if (hold) hold.queue.push(deliver)
    else void deliver().catch(() => { /* the deliverer reports its own failure */ })
  }

  /** Resolves once [agentId] is no longer held: at once for one that is not. */
  whenOpen(agentId: string): Promise<void> {
    return this.holds.get(agentId)?.opened ?? Promise.resolve()
  }

  /**
   * Deliver what was held, one write at a time in arrival order, then let [agentId] go. The mover calls this
   * after the row's runtime has switched (or fallen back), so each write resolves the row's current pane when
   * it runs. A write that fails is its deliverer's to report: the rest still go.
   */
  async release(agentId: string): Promise<void> {
    const hold = this.holds.get(agentId)
    if (!hold) return
    if (hold.draining) return hold.opened
    hold.draining = true
    for (let next = hold.queue.shift(); next; next = hold.queue.shift()) {
      try { await next() } catch { /* reported by the deliverer */ }
    }
    // No await between the empty queue and this: nothing can be queued that would then never run.
    this.holds.delete(agentId)
    hold.open()
  }
}
