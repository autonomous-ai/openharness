/**
 * Turn heartbeats: while a turn is open, every few seconds, check what the agent is really doing, tell
 * the app (activity, and a heartbeat while working) and keep the dial's card alive; stop once the turn
 * is closed and the dial no longer needs it.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 7: docs/design/2026-10-03-harnessd.md).
 */
import { correlateAgentEvent, turnHeartbeatFrame } from '../../lib/agentEvent.js'
import type { CommanderMirror } from '../../lib/commander.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { RuntimeActivityReader } from '../../lib/runtimeActivity.js'
import type { TurnActivity } from '../../lib/turnActivity.js'

export interface HeartbeatDeps {
  bySession: (sessionId: string) => RegisteredSession | undefined
  sessionTurnOpen: (sessionId: string) => boolean
  agentIdFor: (sessionId: string) => string
  runtimeActivity: Pick<RuntimeActivityReader, 'forget'>
  turnActivity: Pick<TurnActivity, 'check' | 'snapshot' | 'forget'>
  mirror: Pick<CommanderMirror, 'heartbeat'>
  /** The app. */
  clients: { send(frame: ReturnType<typeof correlateAgentEvent>): void }
}

export function createHeartbeats({ bySession, sessionTurnOpen, agentIdFor, runtimeActivity, turnActivity, mirror, clients }: HeartbeatDeps) {
  // A timer is an opportunity to inspect work, not proof that work is happening.
  // Keep polling unfinished transcripts even when their activity lease expires:
  // a missed file notification or a later completion must still be discovered.
  const TURN_HEARTBEAT_MS = 5000
  const heartbeats = new Map<string, NodeJS.Timeout>()
  const turnStartedAt = new Map<string, number>()
  const stopHeartbeat = (sessionId: string): void => {
    runtimeActivity.forget(sessionId)
    const timer = heartbeats.get(sessionId)
    if (timer) { clearInterval(timer); heartbeats.delete(sessionId) }
  }
  const startHeartbeat = (sessionId: string): void => {
    stopHeartbeat(sessionId)
    const beat = async () => {
      if (!bySession(sessionId)?.active) {
        stopHeartbeat(sessionId); turnActivity.forget(sessionId); return
      }
      if (sessionTurnOpen(sessionId)) await turnActivity.check(sessionId)
      if (!heartbeats.has(sessionId)) return
      const activity = turnActivity.snapshot(sessionId)
      if (activity) {
        clients.send(correlateAgentEvent({ type: 'agent_activity', payload: { activity } }, sessionId, agentIdFor(sessionId)))
        if (activity.state === 'working') clients.send(turnHeartbeatFrame(sessionId, agentIdFor(sessionId), activity))
      }
      const deviceBusy = mirror.heartbeat(sessionId)
      if (!sessionTurnOpen(sessionId) && !deviceBusy) stopHeartbeat(sessionId)
    }
    const timer = setInterval(() => { void beat().catch(error => console.error('[activity] probe failed:', String(error))) }, TURN_HEARTBEAT_MS)
    heartbeats.set(sessionId, timer)
  }
  return { heartbeats, turnStartedAt, stopHeartbeat, startHeartbeat }
}

export type Heartbeats = ReturnType<typeof createHeartbeats>
