/** The core waits 27 s, so a hold that runs out is answered here, as an empty hold the mod follows at once. */
const HOLD_MS = 25_000
/** The mod opens its next poll at once after one closes; this long after, it is not coming. */
const READY_MS = 35_000
/** A transcript waits this long for the mod's next poll, then the dial says the agent did not answer. */
const WAIT_MS = 5_000
/** Sessions whose last poll closed recently; past this many the oldest goes. */
const MAX_CLOSED = 256

export interface InboxDeps {
  now(): number
  /** Runs `run` after `ms`; the result cancels it. */
  after(ms: number, run: () => void): () => void
}

type Poll = { pollId: string; resolve: (answer: { text?: string }) => void; cancel: () => void }
type Waiting = { text: string; resolve: (taken: boolean) => void; cancel: () => void }

/**
 * The mod's long polls, one per Claude Code session, and the dial's transcripts for them. A transcript lives only until
 * a poll takes it or its 5 s pass: nothing is queued for later.
 */
export class Inbox {
  /** Each session's open poll. The core admits at most 64, which bounds them here. */
  private readonly polls = new Map<string, Poll>()
  /** Each session's one transcript waiting for its next poll. */
  private readonly waiting = new Map<string, Waiting>()
  /** When each session's last poll closed, oldest first. */
  private readonly closed = new Map<string, number>()

  constructor(private readonly deps: InboxDeps) {}

  poll(pollId: string, sessionId: string): Promise<{ text?: string }> {
    // The newer poll is the one its client still waits on: it is held, never answered at once, or the mod asks again at once.
    const older = this.polls.get(sessionId)
    if (older) this.close(sessionId, older, {})
    const waiting = this.waiting.get(sessionId)
    if (waiting) {
      this.endWait(sessionId, waiting, true)
      this.closedNow(sessionId)
      return Promise.resolve({ text: waiting.text })
    }
    return new Promise((resolve) => {
      const held: Poll = { pollId, resolve, cancel: this.deps.after(HOLD_MS, () => this.close(sessionId, held, {})) }
      this.polls.set(sessionId, held)
    })
  }

  /** The poll's client went, or a newer poll replaced it. */
  gone(pollId: string): void {
    for (const [sessionId, open] of this.polls) {
      if (open.pollId === pollId) {
        this.close(sessionId, open, {})
        return
      }
    }
  }

  ready(sessionId: string): boolean {
    return this.polls.has(sessionId) || this.recent(sessionId)
  }

  /** True when a poll took the text. The mod sends no acknowledgement: that is all "sent" can mean. */
  deliver(sessionId: string, text: string): Promise<boolean> {
    const open = this.polls.get(sessionId)
    if (open) {
      this.close(sessionId, open, { text })
      return Promise.resolve(true)
    }
    if (this.waiting.has(sessionId) || !this.recent(sessionId)) return Promise.resolve(false)
    return new Promise((resolve) => {
      const waiting: Waiting = { text, resolve, cancel: this.deps.after(WAIT_MS, () => this.endWait(sessionId, waiting, false)) }
      this.waiting.set(sessionId, waiting)
    })
  }

  /** The core that held the polls connected again, or the devices stop. */
  closeAll(): void {
    for (const [sessionId, open] of this.polls) this.close(sessionId, open, {})
    for (const [sessionId, waiting] of this.waiting) this.endWait(sessionId, waiting, false)
    // Those polls died with their core, and the mod waits 60 s after a failed poll: none comes back within 35 s.
    this.closed.clear()
  }

  private close(sessionId: string, open: Poll, answer: { text?: string }): void {
    this.polls.delete(sessionId)
    open.cancel()
    this.closedNow(sessionId)
    open.resolve(answer)
  }

  private endWait(sessionId: string, waiting: Waiting, taken: boolean): void {
    this.waiting.delete(sessionId)
    waiting.cancel()
    waiting.resolve(taken)
  }

  private closedNow(sessionId: string): void {
    // Set again rather than updated, so the map stays in the order the polls closed and the oldest is first.
    this.closed.delete(sessionId)
    this.closed.set(sessionId, this.deps.now())
    this.drop()
  }

  private recent(sessionId: string): boolean {
    this.drop()
    return this.closed.has(sessionId)
  }

  /** From the oldest: each closed 35 s ago or more, and any past the 256 kept. */
  private drop(): void {
    const now = this.deps.now()
    for (const [sessionId, at] of this.closed) {
      if (now - at < READY_MS && this.closed.size <= MAX_CLOSED) return
      this.closed.delete(sessionId)
    }
  }
}
