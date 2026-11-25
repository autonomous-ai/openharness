import { randomUUID } from 'node:crypto'

export type AgentNotification = { id: string; kind: 'done' | 'needsYou' }

/** How long a turn's end must stay quiet before it is announced: a /goal loop's next pass, or a question, opening
 * within it means the person is not done with the agent yet. */
export const DONE_QUIET_MS = 1_500

/** Why a turn's end is not news, in fixed words the devices log (never an id or text): the caller's silent (a
 * sub-agent's or abandoned turn), not eligible (a replayed, cancelled or already-decided turn), no result text, a
 * question waiting at the end, the session's next turn first, no turn known; and a recap restored after its turn
 * ended unseen (CommanderMirror.catchUp, named by cable/cableHost.ts). */
export const QUIET = ['subagent', 'replay', 'empty', 'question', 'next-turn', 'gone', 'restored'] as const
export type Quiet = typeof QUIET[number]

type Tell = (notification: AgentNotification | null, quiet?: Quiet) => void
type Turn = {
  id: string
  eligible: boolean
  replay: boolean
  endedAt?: number
  pending?: { timer: NodeJS.Timeout; tell: Tell }
}

/** The notification decision shared by desktop and device. Live device cards
 * do not pass through this policy: tools, progress and streaming stay live.
 * CommanderMirror calls decide only after the whole turn has settled and
 * its final answer has been resolved. QuestionWatcher owns actionable input. */
export class AgentNotifications {
  private readonly turns = new Map<string, Turn>()
  private readonly questions = new Map<string, string>()

  started(sessionId: string, replay = false): void {
    const previous = this.turns.get(sessionId)
    if (previous) this.drop(previous, 'next-turn')
    this.turns.set(sessionId, { id: randomUUID(), eligible: !replay, replay })
  }

  continued(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    // Attaching mid-turn replays its opening. The live continuation is still
    // real work, whereas a completed historical turn stays silent.
    if (turn?.replay) { turn.replay = false; turn.eligible = true }
  }

  /** The turn ended now: its done notification is decided DONE_QUIET_MS from here. A second end heard for the same
   * turn (its transcript and its Stop) keeps the first's window. */
  ended(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    // The monotonic clock: a wall clock set back inside the window would hold Finished back by the jump.
    if (turn) turn.endedAt ??= performance.now()
  }

  /**
   * Decide the ended turn's notification. `tell` is called once: when the quiet window ends, or at once when it
   * already has; with null at once when the session's next turn starts first. Never for a session forgotten first.
   * A null always comes with why (Quiet).
   */
  decide(sessionId: string, result: string, silent: boolean, tell: Tell): void {
    const turn = this.turns.get(sessionId)
    if (!turn) return tell(null, 'gone')
    const eligible = turn.eligible
    turn.eligible = false // Duplicate completion never creates another alert.
    turn.replay = false
    if (!eligible) return tell(null, 'replay')
    if (silent) return tell(null, 'subagent')
    if (!result.trim()) return tell(null, 'empty')
    // A question asked inside the window is the person's news instead of this end.
    const decided = (): void => {
      turn.pending = undefined
      if (this.questions.has(sessionId)) tell(null, 'question')
      else tell({ id: turn.id, kind: 'done' })
    }
    // An end this policy never heard is long past: decided at once.
    const wait = DONE_QUIET_MS - (performance.now() - (turn.endedAt ?? -Infinity))
    if (wait <= 0) return decided()
    const timer = setTimeout(decided, wait)
    timer.unref()
    turn.pending = { timer, tell }
  }

  asked(sessionId: string, requestId: string): AgentNotification {
    this.questions.set(sessionId, requestId)
    return { id: requestId, kind: 'needsYou' }
  }

  /** A question waits on the person in this session. */
  asking(sessionId: string): boolean { return this.questions.has(sessionId) }

  /** The ask is closed, not the turn: a permission prompt or a question sits inside a turn that goes on, and that
   * turn's end is decided as any turn's. */
  answered(sessionId: string, requestId: string): void {
    if (this.questions.get(sessionId) === requestId) this.questions.delete(sessionId)
  }

  cancelled(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    if (turn) { turn.eligible = false; turn.replay = false; this.drop(turn, 'replay') }
  }

  forget(sessionId: string): void {
    clearTimeout(this.turns.get(sessionId)?.pending?.timer)
    this.turns.delete(sessionId)
    this.questions.delete(sessionId)
  }

  /** A decision still in its window is told null now, so its recap lands before whatever replaced the turn. */
  private drop(turn: Turn, quiet: Quiet): void {
    if (!turn.pending) return
    clearTimeout(turn.pending.timer)
    const { tell } = turn.pending
    turn.pending = undefined
    tell(null, quiet)
  }
}
