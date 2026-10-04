/**
 * Cancelling a turn: the person interrupted it (C-c from the app, or a stop that must not wait). The
 * turn is marked closed in whichever engine holds it, input is told, the heartbeat and the question
 * watcher stop, and the device's tile closes without a recap.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 10: docs/design/2026-10-03-harnessd.md).
 */
import type { CursorSubagentManager } from '../../engines/cursor/subagent.js'
import type { QuestionWatcher } from '../../lib/askQuestion.js'
import type { AutonomousDeviceService } from '../../lib/autonomous-device/service.js'
import type { CommanderMirror } from '../../lib/commander.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { SessionInputController } from '../../lib/sessionInput.js'
import type { SessionNormalizers } from '../transcripts/normalizers.js'

export interface CancelDeps {
  resolve: (id: string) => RegisteredSession | undefined
  normalizers: Pick<SessionNormalizers, 'closeTurns'>
  cursorSubagents: Pick<CursorSubagentManager, 'forget'>
  input: Pick<SessionInputController, 'cancel' | 'cancelConfirmed'>
  /** The Harness device service, once it exists. */
  device: () => Pick<AutonomousDeviceService, 'turnEnded'> | undefined
  stopHeartbeat: (sessionId: string) => void
  questionWatcher: Pick<QuestionWatcher, 'stop'>
  mirror: Pick<CommanderMirror, 'cancel'>
}

export function createCancel({ resolve, normalizers, cursorSubagents, input, device, stopHeartbeat, questionWatcher, mirror }: CancelDeps) {
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
    return cancelled
  }
  return cancelAgent
}
