/**
 * Turn heartbeats: while a turn is open, every few seconds, check what the agent is really doing, tell
 * the app (a heartbeat while working, else its activity when it changed) and keep the dial's card alive;
 * stop once the turn is closed and the dial no longer needs it. A cancel and a wait tell the app at once.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 7: docs/design/2026-10-03-harnessd.md).
 */
import { correlateAgentEvent, turnHeartbeatFrame } from '../../lib/agentEvent.js'
import type { TurnRecaps } from './recaps.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { RuntimeActivityReader } from '../../lib/runtimeActivity.js'
import type { TurnActivity } from '../../lib/turnActivity.js'
import type { TurnHooks } from './turnHooks.js'

export interface HeartbeatDeps {
  bySession: (sessionId: string) => RegisteredSession | undefined
  sessionTurnOpen: (sessionId: string) => boolean
  agentIdFor: (sessionId: string) => string
  runtimeActivity: Pick<RuntimeActivityReader, 'forget'>
  turnActivity: Pick<TurnActivity, 'check' | 'snapshot' | 'forget'>
  mirror: Pick<TurnRecaps, 'heartbeat'>
  /** The app. */
  clients: { send(frame: ReturnType<typeof correlateAgentEvent>): void }
  turns: Pick<TurnHooks, 'beat'>
}

export function createHeartbeats({ bySession, sessionTurnOpen, agentIdFor, runtimeActivity, turnActivity, mirror, clients, turns }: HeartbeatDeps) {
  // A timer is an opportunity to inspect work, not proof that work is happening.
  // Keep polling unfinished transcripts even when their activity lease expires:
  // a missed file notification or a later completion must still be discovered.
  const TURN_HEARTBEAT_MS = 5000
  const heartbeats = new Map<string, NodeJS.Timeout>()
  const turnStartedAt = new Map<string, number>()
  // One frame a beat. One Desktop's day (2026-10-30) had 32,819 agent_activity and 28,411 turn_heartbeat, the same
  // activity twice while working, and an idle or waiting session's every 5 s. Working goes as turn_heartbeat alone (the
  // phone reads only it; every app reads `activity` from it). Anything else goes as agent_activity when it changed since
  // the last one sent: by state and epoch, not revision, which every probe of an idle open turn moves with nothing new.
  const lastSent = new Map<string, string>()
  /** Every window reads the agent's activity as it is now, not at its next beat. */
  const tell = (sessionId: string): void => {
    const activity = turnActivity.snapshot(sessionId)
    if (activity) clients.send(correlateAgentEvent({ type: 'agent_activity', payload: { activity } }, sessionId, agentIdFor(sessionId)))
  }
  const stopHeartbeat = (sessionId: string): void => {
    runtimeActivity.forget(sessionId)
    lastSent.delete(sessionId)
    const timer = heartbeats.get(sessionId)
    if (timer) { clearInterval(timer); heartbeats.delete(sessionId) }
  }
  const startHeartbeat = (sessionId: string): void => {
    stopHeartbeat(sessionId)
    const beat = async () => {
      if (!bySession(sessionId)?.active) {
        stopHeartbeat(sessionId); turnActivity.forget(sessionId); return
      }
      // First: an end whose Stop never came goes on here, and the turn it closes is not checked as open.
      turns.beat(sessionId)
      if (sessionTurnOpen(sessionId)) await turnActivity.check(sessionId)
      if (!heartbeats.has(sessionId)) return
      const activity = turnActivity.snapshot(sessionId)
      if (activity) {
        const said = `${activity.state}:${activity.epoch}`
        if (activity.state === 'working') clients.send(turnHeartbeatFrame(sessionId, agentIdFor(sessionId), activity))
        else if (lastSent.get(sessionId) !== said) tell(sessionId)
        lastSent.set(sessionId, said)
      }
      const deviceBusy = mirror.heartbeat(sessionId)
      if (!sessionTurnOpen(sessionId) && !deviceBusy) stopHeartbeat(sessionId)
    }
    const timer = setInterval(() => { void beat().catch(error => console.error('[activity] probe failed:', String(error))) }, TURN_HEARTBEAT_MS)
    heartbeats.set(sessionId, timer)
  }
  return { heartbeats, turnStartedAt, stopHeartbeat, startHeartbeat, tell }
}

export type Heartbeats = ReturnType<typeof createHeartbeats>
