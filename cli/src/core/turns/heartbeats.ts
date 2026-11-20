/**
 * Turn heartbeats: while a turn is open, every few seconds, check what the agent is really doing, tell
 * the app (a heartbeat while working, else its activity when it changed) and keep the dial's card alive;
 * stop once the turn is closed and the dial no longer needs it. A cancel and a wait tell the app at once.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 7: docs/design/2026-10-03-harnessd.md).
 */
import { correlateAgentEvent, turnHeartbeatFrame } from '../../lib/agentEvent.js'
import { errorKind } from '../../lib/log.js'
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
  // activity twice while working, and an idle or waiting session's every 5 s. Working in an open turn goes as
  // turn_heartbeat alone (the phone reads only it; every app reads `activity` from it). Anything else, a claim with no
  // turn open included, goes as agent_activity when it changed since the last one sent: by state and epoch, not
  // revision, which every probe of an idle open turn moves with nothing new.
  const lastSent = new Map<string, string>()
  /** Every window reads the agent's activity as it is now, not at its next beat. */
  const tell = (sessionId: string): void => {
    const activity = turnActivity.snapshot(sessionId)
    if (activity) clients.send(correlateAgentEvent({ type: 'agent_activity', payload: { activity } }, sessionId, agentIdFor(sessionId)))
  }
  const tellChanged = (sessionId: string): void => {
    const activity = turnActivity.snapshot(sessionId)
    const said = activity && `${activity.state}:${activity.epoch}`
    if (!said || lastSent.get(sessionId) === said) return
    lastSent.set(sessionId, said)
    tell(sessionId)
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
      // Stopped while the check ran, or replaced: by a claim watch (a cancel's late output) or a new turn's heartbeat.
      if (heartbeats.get(sessionId) !== timer) return
      const activity = turnActivity.snapshot(sessionId)
      if (activity?.state === 'working' && sessionTurnOpen(sessionId)) {
        clients.send(turnHeartbeatFrame(sessionId, agentIdFor(sessionId), activity))
        // The turn's end then reaches the apps in its own frame, unseen here: the next agent_activity always goes.
        lastSent.delete(sessionId)
      } else tellChanged(sessionId)
      const deviceBusy = mirror.heartbeat(sessionId)
      if (sessionTurnOpen(sessionId) || deviceBusy) return
      // A claim that started after the turn closed (a paste a second after `wait` returned) is a claim watch's to end.
      if (activity?.state === 'working') { clearInterval(timer); watch(sessionId) } else stopHeartbeat(sessionId)
    }
    const timer = setInterval(() => { void beat().catch(error => console.error('[activity] probe failed:', errorKind(error))) }, TURN_HEARTBEAT_MS)
    heartbeats.set(sessionId, timer)
  }
  /**
   * Tells a claim's end on the beat that reads it. It probes nothing and forgets no reading: the next pane read is
   * compared with the last.
   */
  const watch = (sessionId: string): void => {
    const timer = setInterval(() => {
      // An open turn's heartbeat says the rest, and an agent no longer active has no one to tell.
      if (bySession(sessionId)?.active && !sessionTurnOpen(sessionId)) {
        if (turnActivity.snapshot(sessionId)?.state === 'working') return
        tell(sessionId)
      }
      clearInterval(timer)
      heartbeats.delete(sessionId)
      lastSent.delete(sessionId)
    }, TURN_HEARTBEAT_MS)
    heartbeats.set(sessionId, timer)
  }
  /**
   * Working with no turn open (TurnActivity's `claimed`: a paste, a pane read as busy, output after a cancel) has no beat
   * to tell its end, so `wait` and `watch` would sleep to their backstop. It is told now, and its end on the beat that
   * reads it; its renewals tell nothing, so a claim is two frames. In the beats' map, a turn's heartbeat replaces it
   * and shutdown clears it. A closed turn's heartbeat that still beats keeps its place, and hands the claim on to end.
   *
   * Watched once the read that made it is applied: a read sets the turn's state to where it ends before its events, so
   * a turn that starts and ends in it reads as a claim, and its heartbeat, started meanwhile, tells it instead.
   */
  const watchClaim = (sessionId: string): void => {
    const was = heartbeats.get(sessionId)
    queueMicrotask(() => {
      if (heartbeats.get(sessionId) !== was) return
      tellChanged(sessionId)
      if (!was) watch(sessionId)
    })
  }
  return { heartbeats, turnStartedAt, stopHeartbeat, startHeartbeat, watchClaim, tell }
}

export type Heartbeats = ReturnType<typeof createHeartbeats>
