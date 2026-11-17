import { randomUUID } from 'node:crypto'

export type AgentNotification = { id: string; kind: 'done' | 'needsYou' }

/** How long a turn's end must stay quiet before it is announced: a /goal loop's next pass, or a question, opening
 * within it means the person is not done with the agent yet. */
export const DONE_QUIET_MS = 1_500

type Tell = (notification: AgentNotification | null) => void
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
    if (previous) this.drop(previous)
    this.turns.set(sessionId, { id: randomUUID(), eligible: !replay, replay })
  }

  continued(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    // Attaching mid-turn replays its opening. The live continuation is still
    // real work, whereas a completed historical turn stays silent.
    if (turn?.replay) { turn.replay = false; turn.eligible = true }
  }

  /** The turn ended now: its done notification is decided DONE_QUIET_MS from here. */
  ended(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    // The monotonic clock: a wall clock set back inside the window would hold Finished back by the jump.
    if (turn) turn.endedAt = performance.now()
  }

  /**
   * Decide the ended turn's notification. `tell` is called once: when the quiet window ends, or at once when it
   * already has; with null at once when the session's next turn starts first. Never for a session forgotten first.
   */
  decide(sessionId: string, result: string, silent: boolean, tell: Tell): void {
    const turn = this.turns.get(sessionId)
    if (!turn) return tell(null)
    const eligible = turn.eligible
    turn.eligible = false // Duplicate completion never creates another alert.
    turn.replay = false
    if (!eligible || silent || !result.trim()) return tell(null)
    // A question asked inside the window is the person's news instead of this end.
    const decided = (): void => {
      turn.pending = undefined
      tell(this.questions.has(sessionId) ? null : { id: turn.id, kind: 'done' })
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

  answered(sessionId: string, requestId: string): void {
    if (this.questions.get(sessionId) !== requestId) return
    this.questions.delete(sessionId)
    // A stop caused by answering a prompt is not fresh news. A subsequent
    // real turn_started re-arms completion; no arbitrary time window needed.
    this.cancelled(sessionId)
  }

  cancelled(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    if (turn) { turn.eligible = false; turn.replay = false; this.drop(turn) }
  }

  forget(sessionId: string): void {
    clearTimeout(this.turns.get(sessionId)?.pending?.timer)
    this.turns.delete(sessionId)
    this.questions.delete(sessionId)
  }

  /** A decision still in its window is told null now, so its recap lands before whatever replaced the turn. */
  private drop(turn: Turn): void {
    if (!turn.pending) return
    clearTimeout(turn.pending.timer)
    const { tell } = turn.pending
    turn.pending = undefined
    tell(null)
  }
}
