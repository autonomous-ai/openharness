/**
 * Forgetting a session: release a mutable session binding (the agent stays, its session goes), or
 * remove a process-owned agent everywhere — archived as stopped, and every per-session store the core
 * keeps let go of, so a daemon that runs for days does not grow with every session it ever saw.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 10: docs/design/2026-10-03-harnessd.md).
 */
import { removeCursorPendingTasks } from '../../engines/cursor/pendingTasks.js'
import type { CursorTranscriptDiscovery } from '../../engines/cursor/discovery.js'
import type { CursorSubagentManager } from '../../engines/cursor/subagent.js'
import type { AutonomousDeviceInput } from '../deviceInput.js'
import type { TurnRecaps } from '../turns/recaps.js'
import { sid } from '../../lib/log.js'
import type { registry } from '../../lib/registry.js'
import type { RuntimeProfileManager } from '../../lib/runtimeProfile.js'
import type { SessionInputController } from '../../lib/sessionInput.js'
import type { StoppedAgentStore } from '../../lib/stoppedAgents.js'
import type { SwarmPromptScopes } from '../../teams/promptScope.js'
import type { Watcher } from '../../watcher/watcher.js'
import type { SessionNormalizers } from '../transcripts/normalizers.js'

type Frame = { type: string; payload: Record<string, unknown> }

export interface ForgetDeps {
  registry: Pick<typeof registry, 'resolve' | 'unbindSession' | 'removeAgent' | 'remove'>
  stoppedAgents: Pick<StoppedAgentStore, 'save'>
  syncRecapPool: () => void
  normalizers: Pick<SessionNormalizers, 'forget'>
  turnStartedAt: Map<string, number>
  /** Attach's two per-session marks (core/transcripts/attach.ts). */
  neverFoldedHistory: Set<string>
  replayedFirstTurn: Set<string>
  clearAgyIdleWatch: (sessionId: string) => void
  cursorDiscovery: Pick<CursorTranscriptDiscovery, 'remove'>
  cursorSubagents: Pick<CursorSubagentManager, 'forget'>
  runtimeProfiles: Pick<RuntimeProfileManager, 'forget'>
  watcher: Pick<Watcher, 'removeSession'>
  stopHeartbeat: (sessionId: string) => void
  teams: Pick<SwarmPromptScopes, 'forget'>
  input: Pick<SessionInputController, 'forget'>
  deviceInput: Pick<AutonomousDeviceInput, 'forget'>
  detachDsh: (agentId: string) => void
  mirror: Pick<TurnRecaps, 'forget'>
  /** The app (`send`) and the dial (`sendCommander`). */
  clients: { send(frame: Frame): void; sendCommander(frame: Frame): void }
  dataDir: string
}

export function createForgetSession({
  registry, stoppedAgents, syncRecapPool, normalizers, turnStartedAt, neverFoldedHistory, replayedFirstTurn,
  clearAgyIdleWatch, cursorDiscovery, cursorSubagents, runtimeProfiles, watcher, stopHeartbeat, teams, input,
  deviceInput, detachDsh, mirror, clients, dataDir,
}: ForgetDeps) {
  /** Release a mutable session binding, or remove the process-owned agent everywhere. */
  const forgetSession = (
    id: string,
    opts: { force?: boolean; keepAgent?: boolean; agentId?: string } = {},
  ): void => {
    const doomed = registry.resolve(id)
    const sessionId = doomed?.sessionId || id
    // Clients key on the AGENT id. Normally it is read off the entry, but an
    // agent already removed from the registry cannot be looked up — and
    // announcing its sessionId instead is silently useless: the app takes
    // payload.agentId verbatim, matches nothing, and leaves the dead row on
    // screen. Callers who know the id pass it.
    const announceId = doomed?.agentId ?? opts.agentId ?? sessionId

    console.log(opts.keepAgent
      ? `[agent] ${sid(announceId)} released session ${sid(sessionId)}`
      : `[agent] ${sid(announceId)} forgotten`)

    if (!opts.keepAgent && doomed) stoppedAgents.save(doomed)
    if (opts.keepAgent) registry.unbindSession(sessionId)
    else if (doomed) registry.removeAgent(doomed.agentId)
    else registry.remove(sessionId)
    syncRecapPool()
    normalizers.forget(sessionId)
    turnStartedAt.delete(sessionId)
    neverFoldedHistory.delete(sessionId)
    // Both sets are per-session and must die with it: left behind they grow without bound in a daemon
    // that runs for days, and a session forgotten then re-registered under the same id would inherit a
    // stale "already replayed" and lose a first turn it was entitled to.
    replayedFirstTurn.delete(sessionId)
    clearAgyIdleWatch(sessionId)
    cursorDiscovery.remove(sessionId)
    cursorSubagents.forget(sessionId)
    void removeCursorPendingTasks(dataDir, sessionId)
    runtimeProfiles.forget(sessionId)
    void watcher.removeSession(sessionId)
    stopHeartbeat(sessionId)
    teams.forget(doomed?.agentId ?? sessionId)
    input.forget(doomed?.agentId ?? sessionId)
    deviceInput.forget(doomed?.agentId ?? sessionId)
    if (!opts.keepAgent) detachDsh(announceId)
    mirror.forget(sessionId) // aborts any in-flight recap + clears busy; KEEPS the persisted summary
    if (opts.keepAgent) return
    clients.send({ type: 'agent_deleted', payload: { agentId: announceId, retained: !!doomed } }) // web tab
    clients.sendCommander({ type: 'agent_deleted', payload: { agentId: announceId } })
  }
  return forgetSession
}
