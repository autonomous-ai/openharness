/**
 * Stopping, purging and resuming an agent: the archive side of its lifecycle. Stop keeps the
 * conversation on disk to come back to; purge erases it; resume brings a stopped agent back.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import type { BackendSocket } from '../../backendSocket.js'
import type { clearDeleted as clearDeletedFn, markDeleted as markDeletedFn } from '../../lib/deletedSessions.js'
import { PurgeAgentService } from '../../lib/purgeAgentService.js'
import type { registry } from '../../lib/registry.js'
import { createResumeAgentService, type ResumeAgentServiceDeps } from '../../lib/resumeAgentService.js'
import type { SessionCheckpointStore } from '../../lib/sessionCheckpoint.js'
import type { StoppedAgentStore } from '../../lib/stoppedAgents.js'
import { createStopAgentService, type StopAgentServiceDeps } from '../../lib/stopAgentService.js'

type ResumeAgent = NonNullable<BackendSocket['onResumeAgent']>

export interface LifecycleDeps {
  registry: typeof registry
  stoppedAgents: StoppedAgentStore
  restartJobs: StopAgentServiceDeps['restartJobs']
  tmuxBackend: StopAgentServiceDeps['tmuxBackend'] & ResumeAgentServiceDeps['tmuxBackend']
  agentReconciler: StopAgentServiceDeps['agentReconciler']
  forgetSession: StopAgentServiceDeps['forgetSession']
  markDeleted: typeof markDeletedFn
  clearDeleted: typeof clearDeletedFn
  sessionCheckpoints: SessionCheckpointStore
  /** Where a purged conversation's lines and its search entries are dropped. */
  mirror: { deleteHistory(sessionId: string): void }
  sessionSearch: { deleteHistory(sessionId: string): void } | null
  /** To every connected window. */
  send: (frame: { type: string; payload: Record<string, unknown> }) => void
  pinnedControls: ResumeAgentServiceDeps['pinnedControls']
  retainExitedSession: ResumeAgentServiceDeps['retainExitedSession']
  announceSession: ResumeAgentServiceDeps['announceSession']
  relaunchOverrides: ResumeAgentServiceDeps['relaunchOverrides']
  prepareSessionResume: ResumeAgentServiceDeps['prepareSessionResume']
  refreshGridWebSearch: ResumeAgentServiceDeps['refreshGridWebSearch']
  attachDsh: ResumeAgentServiceDeps['attachDsh']
}

export function createAgentLifecycle({
  registry, stoppedAgents, restartJobs, tmuxBackend, agentReconciler, forgetSession, markDeleted, clearDeleted,
  sessionCheckpoints, mirror, sessionSearch, send, pinnedControls, retainExitedSession, announceSession,
  relaunchOverrides, prepareSessionResume, refreshGridWebSearch, attachDsh,
}: LifecycleDeps) {
  /**
   * Stop Harness (`agent_delete`) archives its conversation and launch settings, removes the live
   * registry entry, and closes only its exact tmux pane. Exact PID/start-marker validation guards the engine's
   * SIGTERM/SIGKILL fallback. Engine conversation files, recaps and the Harness name remain on disk.
   */
  const stopJobs = new Map<string, Promise<void>>()
  const stopAgent = createStopAgentService({
    registry, stoppedAgents, restartJobs, stopJobs, tmuxBackend, agentReconciler,
    forgetSession, markDeleted, clearDeleted,
  })
  const purgeAgentService = new PurgeAgentService({
    live: id => registry.byAgent(id), sessions: () => [...registry.list(), ...stoppedAgents.list()],
    stopped: stoppedAgents, checkpoints: sessionCheckpoints, stop: stopAgent,
    restarting: id => restartJobs.busy(id) || stopJobs.has(id),
    deleted: s => {
      if (s.sessionId) { mirror.deleteHistory(s.sessionId); sessionSearch?.deleteHistory(s.sessionId) }
      registry.deleteSavedNames([s.agentId, s.sessionId].filter(Boolean))
      send({ type: 'agent_deleted', payload: { agentId: s.agentId, retained: false } })
    },
  })

  const resume = createResumeAgentService({
    registry, stoppedAgents, tmuxBackend, restartJobs, stopJobs, pinnedControls,
    retainExitedSession, announceSession, relaunchOverrides, prepareSessionResume,
    refreshGridWebSearch, clearDeleted, attachDsh,
  })
  const resumeAgent: ResumeAgent = (id, permissionMode) => purgeAgentService.busy(id) || purgeAgentService.blocksFolder(stoppedAgents.get(id)?.cwd)
    ? Promise.resolve({ ok: false, error: 'AGENT_BUSY' }) : resume(id, permissionMode)
  return { stopJobs, stopAgent, purgeAgentService, resumeAgent }
}
