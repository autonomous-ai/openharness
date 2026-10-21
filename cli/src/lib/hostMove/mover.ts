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
import type { MoveOutcome } from './moveAgent.js'
import { QUIET_MS, type QuietClock } from './quiet.js'

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
  /** Agents whose move failed since this core started: not tried again until the next start (spec §4). */
  private readonly failed = new Set<string>()
  /** The reason each agent was last said to be skipped, so a skip is logged once per change, not every tick. */
  private readonly skipped = new Map<string, string>()
  private toldCannotSeed = false
  private toldCanSeed = false

  constructor(private readonly deps: HostMoverDeps) {}

  async step(): Promise<void> {
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
