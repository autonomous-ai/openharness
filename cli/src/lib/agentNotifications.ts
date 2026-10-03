import { randomUUID } from 'node:crypto'

export type AgentNotification = { id: string; kind: 'done' | 'needsYou' }

/** The notification decision shared by desktop and device. Live device cards
 * do not pass through this policy: tools, progress and streaming stay live.
 * CommanderMirror calls completed only after the whole turn has settled and
 * its final answer has been resolved. QuestionWatcher owns actionable input. */
export class AgentNotifications {
  private readonly turns = new Map<string, { id: string; eligible: boolean; replay: boolean }>()
  private readonly questions = new Map<string, string>()

  started(sessionId: string, replay = false): void {
    this.turns.set(sessionId, { id: randomUUID(), eligible: !replay, replay })
  }

  continued(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    // Attaching mid-turn replays its opening. The live continuation is still
    // real work, whereas a completed historical turn stays silent.
    if (turn?.replay) { turn.replay = false; turn.eligible = true }
  }

  completed(sessionId: string, result: string, silent: boolean): AgentNotification | null {
    const turn = this.turns.get(sessionId)
    if (!turn) return null
    const eligible = turn.eligible
    turn.eligible = false // Duplicate completion never creates another alert.
    turn.replay = false
    if (!eligible || silent || !result.trim() || this.questions.has(sessionId)) return null
    return { id: turn.id, kind: 'done' }
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
    if (turn) { turn.eligible = false; turn.replay = false }
  }

  forget(sessionId: string): void {
    this.turns.delete(sessionId)
    this.questions.delete(sessionId)
  }
}
