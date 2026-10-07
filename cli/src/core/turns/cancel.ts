/**
 * Cancelling a turn: the person interrupted it (C-c from the app, or a stop that must not wait). The
 * turn is marked closed in whichever engine holds it, input is told, the heartbeat and the question
 * watcher stop, the device's tile closes without a recap, and every window reads the agent as idle.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 10: docs/design/2026-10-03-harnessd.md).
 */
import type { CursorSubagentManager } from '../../engines/cursor/subagent.js'
import { correlateAgentEvent } from '../../lib/agentEvent.js'
import type { QuestionWatcher } from '../../lib/askQuestion.js'
import type { WifiFeed } from '../wifi.js'
import type { TurnRecaps } from './recaps.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { SessionInputController } from '../../lib/sessionInput.js'
import type { TurnActivity } from '../../lib/turnActivity.js'
import type { SessionNormalizers } from '../transcripts/normalizers.js'

export interface CancelDeps {
  resolve: (id: string) => RegisteredSession | undefined
  normalizers: Pick<SessionNormalizers, 'closeTurns'>
  cursorSubagents: Pick<CursorSubagentManager, 'forget'>
  input: Pick<SessionInputController, 'cancel' | 'cancelConfirmed'>
  /** The Wi-Fi device's service, wherever it runs (core/wifi.ts). */
  device: () => Pick<WifiFeed, 'turnEnded'> | undefined
  stopHeartbeat: (sessionId: string) => void
  questionWatcher: Pick<QuestionWatcher, 'stop'>
  mirror: Pick<TurnRecaps, 'cancel'>
  turnActivity: Pick<TurnActivity, 'observe' | 'snapshot'>
  /** When each open turn started (the heartbeats'): the WiFi device reads an agent as running by it. */
  turnStartedAt: Map<string, number>
  agentIdFor: (sessionId: string) => string
  /** The app. */
  clients: { send(frame: ReturnType<typeof correlateAgentEvent>): void }
}

export function createCancel({
  resolve, normalizers, cursorSubagents, input, device, stopHeartbeat, questionWatcher, mirror, turnActivity, turnStartedAt,
  agentIdFor, clients,
}: CancelDeps) {
  // Web cancel (C-c) interrupts the turn — claude writes no end_turn line to close it, so stop the
  // heartbeat and mark the turn closed here (mirrors the hosted runtime stopping its heartbeat on cancel). We do
  // NOT emit turn_ended: the web clears its own dots on cancel, and a turn_ended would fire a device
  // recap for a killed turn. The next real prompt reopens a fresh turn.
  const cancelAgent = (id: string, confirmed = false): Promise<boolean> => {
    const record = resolve(id)
    const sessionId = record?.sessionId ?? id
    normalizers.closeTurns(sessionId)
    cursorSubagents.forget(sessionId)
    const cancelled = confirmed ? input.cancelConfirmed(record?.agentId ?? sessionId) : (input.cancel(record?.agentId ?? sessionId), Promise.resolve(true))
    device()?.turnEnded(record?.agentId ?? sessionId, true)
    stopHeartbeat(sessionId)
    questionWatcher.stop(sessionId)
    mirror.cancel(sessionId) // close the device's "Working…" tile (bare done, no recap) — a cancel emits no turn_ended
    // ...but the turn IS over, and every window — not only the one that cancelled — reads it so at once,
    // rather than as working until the 30-second lease runs out and as unknown after (found end to end).
    // An engine that ignores the interrupt says so with its next output, which reads as working again.
    turnStartedAt.delete(sessionId)
    turnActivity.observe(sessionId, 'turn_ended')
    const activity = turnActivity.snapshot(sessionId)
    if (activity) clients.send(correlateAgentEvent({ type: 'agent_activity', payload: { activity } }, sessionId, agentIdFor(sessionId)))
    return cancelled
  }
  return cancelAgent
}

/**
 * Takes a `cancel` frame: the person interrupted an agent's turn (C-c from the app), the agent named by
 * agent id or session id. Nothing is answered: every window reads the agent as idle once it is.
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md).
 */
export function createCancelRequest(cancel: (id: string) => void) {
  return (payload: Record<string, unknown>): void => {
    const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
    if (target) cancel(target)
  }
}
