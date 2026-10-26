/**
 * Which agent moves to the target pty host, and when (spec §4). After each reconcile pass (core/main.ts
 * `onReconciled`) the mover looks at the agents on the hosts being drained, keeps each one's quiet clock, and moves at
 * most one: the one quiet the longest among those that meet every condition. How a move happens is moveAgent.ts.
 *
 * Moving restarts the engine, so only an agent nobody is using moves: idle (never working, never unknown: a question
 * waiting for its answer reads as working, and the gate's refusal of an answer during a hold relies on that), with no
 * input for `QUIET_MS`, not looked at, and with no restart, stop, restore or held control in flight. An agent that
 * never meets them stays on its old host until it ends.
 */
import { isTerminalEngine, type AgentEngine } from '../../engines/types.js'
import type { RegisteredSession } from '../registry.js'
import type { ActivityState } from '../turnActivity.js'
import type { MoveGate } from './gate.js'
import type { MoveOutcome } from './moveAgent.js'
import { QUIET_MS, type QuietClock } from './quiet.js'

/** How long a hand-over waits for a move that holds input to finish (`settleMovesForHandOver`). */
export const HAND_OVER_MOVE_WAIT_MS = 20_000
/** How long it then gives the held input to be written, when it could not wait the move out. */
export const HAND_OVER_FLUSH_MS = 5_000

export interface HostMoverDeps {
  /** The registry's rows, read on each step. */
  list(): readonly RegisteredSession[]
  /** Whether [row]'s pane is on a drain backend's host: an older one, or a newer one after a downgrade or rollback. */
  isDrainRow(row: RegisteredSession): boolean
  /** Whether the target host can seed a pane (`PtyHostBackend.canSeed`): a pre-G target gets no moves. */
  targetCanSeed(): boolean
  /** The target host's instance, for the line that says it cannot seed. */
  target: string
  /** `resumesConversation` (resumeCapability.ts): the engine has a resume argv and the row a session id. */
  resumesConversation(engine: AgentEngine, sessionId: string | null | undefined): boolean
  /** The agent's working state as the windows are told it (`activityFrame`). */
  activity(row: RegisteredSession): ActivityState
  quiet: QuietClock
  /** A person can see its terminal (`TerminalStreamManager.isLookedAt`, a Share viewer's stream). */
  lookedAt(agentId: string): boolean
  /** A restart, stop, restore or held control owns the agent now. */
  busy(agentId: string): boolean
  /** One move (moveAgent.ts), run as the agent's lifecycle operation. */
  move(row: RegisteredSession): Promise<MoveOutcome>
  log(message: string): void
}

export class HostMover {
  private moving = false
  /** The move in flight, settled once it has ended (its gate released). */
  private inFlight: Promise<void> | null = null
  private halted = false
  /** Agents whose move failed since this core started: not tried again until the next start (spec §4). */
  private readonly failed = new Set<string>()
  /** The reason each agent was last said to be skipped, so a skip is logged once per change, not every tick. */
  private readonly skipped = new Map<string, string>()
  private toldCannotSeed = false
  private toldCanSeed = false

  constructor(private readonly deps: HostMoverDeps) {}

  /** No move starts from now on: the core is handing over (`settleMovesForHandOver`). One in flight goes on. */
  stop(): void {
    this.halted = true
  }

  get stopped(): boolean {
    return this.halted
  }

  /** Settles once the move in flight, if any, has ended. */
  settled(): Promise<void> {
    return this.inFlight ?? Promise.resolve()
  }

  async step(): Promise<void> {
    if (this.halted) return
    if (!this.deps.targetCanSeed()) {
      if (!this.toldCannotSeed) {
        this.toldCannotSeed = true
        this.deps.log(`[terminal] ptyhost: target ${this.deps.target} cannot seed; agents stay on their hosts`)
      }
      return
    }
    // A target attached after the first tick (or reconnected to a newer build) may seed after all: say so once.
    if (this.toldCannotSeed && !this.toldCanSeed) {
      this.toldCanSeed = true
      this.deps.log(`[terminal] ptyhost: target ${this.deps.target} can seed now; idle agents move to it`)
    }
    const rows = this.deps.list().filter((row) => this.deps.isDrainRow(row))
    // Each tick reads every drain agent's state, a move in flight or not: the quiet clock starts at the first idle.
    for (const row of rows) this.deps.quiet.noteActivity(row.agentId, this.deps.activity(row))
    const present = new Set(rows.map((row) => row.agentId))
    for (const agentId of this.skipped.keys()) if (!present.has(agentId)) this.skipped.delete(agentId)
    if (this.moving) return

    let pick: { row: RegisteredSession; quietFor: number } | null = null
    for (const row of rows) {
      const reason = this.refusal(row)
      if (reason) { this.skip(row.agentId, reason); continue }
      const quietFor = this.deps.quiet.quietFor(row.agentId)
      if (!pick || quietFor > pick.quietFor) pick = { row, quietFor }
    }
    if (!pick) return
    const { row } = pick
    this.skipped.delete(row.agentId)
    this.moving = true
    let ended!: () => void
    this.inFlight = new Promise<void>((resolve) => { ended = resolve })
    try {
      let outcome: MoveOutcome
      try { outcome = await this.deps.move(row) } catch (error) {
        outcome = { moved: false, reason: error instanceof Error ? error.message : String(error), fellBack: false }
      }
      if (outcome.moved) {
        this.deps.log(`[terminal] move ${row.agentId}: moved (${outcome.resumed ? 'resumed' : 'fresh'})`)
      } else if (outcome.cancelled) {
        // Someone reached for the agent, or a Stop or delete took it: nothing failed, and once it is quiet again it
        // may move.
        this.skip(row.agentId, outcome.reason)
      } else {
        this.failed.add(row.agentId)
        this.deps.log(`[terminal] move ${row.agentId}: failed (${outcome.reason})`)
      }
    } finally {
      this.moving = false
      this.inFlight = null
      ended()
    }
  }

  /** Why [row] may not move now, or null when it may. Permanent reasons first, then the ones a tick can change. */
  private refusal(row: RegisteredSession): string | null {
    if (isTerminalEngine(row.engine)) return 'a terminal'
    if (!row.sessionId) return 'no session id'
    if (!this.deps.resumesConversation(row.engine, row.sessionId)) return 'its engine cannot resume'
    // A guest's harness runs as the guest's own user; relaunched here it would run as the owner (restoreAgents.ts).
    if (row.guest) return "a guest's harness"
    if (this.failed.has(row.agentId)) return 'a move failed this start'
    // Held, starting or failed: no engine of its own runs in the pane to move.
    if (row.launch && row.launch.state !== 'ready') return 'not launched'
    if (!row.processIdentity) return 'no engine process'
    const activity = this.deps.activity(row)
    if (activity === 'working') return 'working'
    if (activity !== 'idle') return 'activity unknown'
    if (this.deps.quiet.quietFor(row.agentId) < QUIET_MS) return 'not quiet yet'
    if (this.deps.lookedAt(row.agentId)) return 'looked at'
    if (this.deps.busy(row.agentId)) return 'busy'
    return null
  }

  private skip(agentId: string, reason: string): void {
    if (this.skipped.get(agentId) === reason) return
    this.skipped.set(agentId, reason)
    this.deps.log(`[terminal] move ${agentId}: skipped (${reason})`)
  }
}

/**
 * What a hand-over does first, before its teardown closes the connections held input would be written through: no move
 * starts any more ([mover] stopped: one not yet past its old engine's stop cancels itself there, core/main.ts
 * `eligible`), and a move that holds input is waited for, at most [waitMs]: its own release then writes what was held
 * to the pane that stays. Past the bound, every held input is written to the pane each row names now (`releaseAll`),
 * within [flushMs], and the hand-over goes on. Nothing held: nothing to wait for. Both bounds and the teardown's own
 * (core/updateHandoff.ts `TEARDOWN_DEADLINE_MS`) fit in the master's hand-over grace (harnessd/supervisor.ts).
 */
export async function settleMovesForHandOver(o: {
  mover: Pick<HostMover, 'stop' | 'settled'> | null
  gate: Pick<MoveGate, 'held' | 'releaseAll'>
  log: (line: string) => void
  waitMs?: number
  flushMs?: number
}): Promise<void> {
  o.mover?.stop()
  if (o.gate.held().length === 0) return
  const waitMs = o.waitMs ?? HAND_OVER_MOVE_WAIT_MS
  if (o.mover) await within(o.mover.settled(), waitMs)
  const held = o.gate.held()
  if (held.length === 0) return
  o.log(`[terminal] move: a move still holds the input of ${held.join(', ')} after ${waitMs / 1000} s — delivering it to the pane the row names before handing over`)
  await within(o.gate.releaseAll(), o.flushMs ?? HAND_OVER_FLUSH_MS)
}

/** [work], or nothing once [ms] have passed. */
async function within(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })])
  } finally {
    clearTimeout(timer)
  }
}
