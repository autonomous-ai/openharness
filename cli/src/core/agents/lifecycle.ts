/**
 * Stopping, purging and resuming an agent: the archive side of its lifecycle. Stop keeps the
 * conversation on disk to come back to; purge erases it; resume brings a stopped agent back.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import type { clearDeleted as clearDeletedFn, markDeleted as markDeletedFn } from '../../lib/deletedSessions.js'
import { PurgeAgentService } from '../../lib/purgeAgentService.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import { createResumeAgentService, type ResumeAgentServiceDeps } from '../../lib/resumeAgentService.js'
import type { SessionCheckpointStore } from '../../lib/sessionCheckpoint.js'
import type { StoppedAgentStore } from '../../lib/stoppedAgents.js'
import { AgentStopError, createStopAgentService, type StopAgentServiceDeps } from '../../lib/stopAgentService.js'

import type { ResumeAgent } from './launches.js'

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
  attachSession: ResumeAgentServiceDeps['attachSession']
  relaunchMarks?: ResumeAgentServiceDeps['relaunchMarks']
}

export function createAgentLifecycle({
  registry, stoppedAgents, restartJobs, tmuxBackend, agentReconciler, forgetSession, markDeleted, clearDeleted,
  sessionCheckpoints, mirror, sessionSearch, send, pinnedControls, retainExitedSession, announceSession,
  relaunchOverrides, prepareSessionResume, refreshGridWebSearch, attachDsh, attachSession, relaunchMarks,
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
    refreshGridWebSearch, clearDeleted, attachDsh, attachSession, relaunchMarks,
  })
  const resumeAgent: ResumeAgent = (id, permissionMode) => purgeAgentService.busy(id) || purgeAgentService.blocksFolder(stoppedAgents.get(id)?.cwd)
    ? Promise.resolve({ ok: false, error: 'AGENT_BUSY' }) : resume(id, permissionMode)
  return { stopJobs, stopAgent, purgeAgentService, resumeAgent }
}

/**
 * The reply to `agent_delete`: Stop Harness, for the agent the frame names. Its validated engine process
 * is signalled and it leaves the list; its recap and name stay for a later resume. Idempotent: a target
 * already gone is still acknowledged, and `agent_deleted` sent again, so the windows and the device
 * converge. A frame that says which conversation it reviewed (`expectedSessionId`) is refused once that
 * conversation has changed, so a stop never lands on a conversation the person did not see. A stop that
 * could not confirm its process ended says so: never a false success.
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md).
 */
export function createStopRequest({ byAgent, stop }: {
  byAgent: (agentId: string) => RegisteredSession | undefined
  stop: (agentId: string) => void | Promise<void>
}) {
  return async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
    if (!target) return { error: 'MISSING_AGENT_ID' }
    if (Object.hasOwn(payload, 'expectedSessionId')) {
      const current = byAgent(target)
      if (!current || (current.sessionId || null) !== payload.expectedSessionId) {
        return { error: 'SESSION_CHANGED', detail: 'This conversation changed. Refresh and review it before stopping.' }
      }
    }
    try { await stop(target) }
    catch (error) {
      if (!(error instanceof AgentStopError)) throw error
      return { error: error.code, detail: error.message }
    }
    return { deleted: true }
  }
}

/**
 * Answers `agent_purge` and `agent_worktree_delete`: permanent deletion, reviewed first. It deletes what
 * the owner chose, so only the owner may ask: the loopback window, or a sealed `web` session. Every
 * request names the identity it reviewed, and a deletion the review it acts on. Detached: a deletion can
 * take seconds, and terminal input and other agents keep flowing meanwhile.
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md).
 */
export function createPurgeRequest({ purgeAgentService, invalidateStorage }: {
  /** The purge service, once it exists. */
  purgeAgentService: () => Pick<PurgeAgentService, 'request' | 'worktreeRequest'> | null
  /** Forgets the monitor's storage readings, once something was deleted. */
  invalidateStorage: () => void
}) {
  return (type: string, payload: Record<string, unknown>, asker: { owner: boolean }, reply: (result: Record<string, unknown>) => void): void => {
    if (!asker.owner) { reply({ error: 'OWNER_REQUIRED' }); return }
    const service = purgeAgentService()
    if (!service) { reply({ error: 'UNSUPPORTED' }); return }
    const { agentId, sessionId, createdAt, mode, reviewId, path, discardChanges, choices, includeWorktree } = payload
    const selected = choices && typeof choices === 'object' ? choices as Record<string, unknown> : null
    if (typeof agentId !== 'string' || !(sessionId === null || typeof sessionId === 'string')
      || typeof createdAt !== 'number' || !Number.isFinite(createdAt)
      || (mode !== 'inspect' && mode !== 'delete' && !(type === 'agent_worktree_delete' && mode === 'describe'))
      || (mode === 'delete' && typeof reviewId !== 'string')
      || (choices !== undefined && (!selected
        || typeof selected.sessionData !== 'boolean' || typeof selected.worktreeData !== 'boolean'))) {
      reply({ error: 'INVALID_DELETE_REQUEST' }); return
    }
    const deletion = { agentId, sessionId, createdAt, mode: mode as 'inspect' | 'delete',
      ...(typeof reviewId === 'string' ? { reviewId } : {}),
      ...(typeof path === 'string' ? { path } : {}), discardChanges: discardChanges === true,
      includeWorktree: includeWorktree === true,
      ...(selected ? { choices: { sessionData: selected.sessionData as boolean, worktreeData: selected.worktreeData as boolean } } : {}) }
    const operation = type === 'agent_worktree_delete'
      ? service.worktreeRequest({ ...deletion, mode: mode as 'describe' | 'inspect' | 'delete' })
      : service.request(deletion)
    void operation
      .then(result => {
        if (result.deleted === true || result.worktreeDeleted === true) invalidateStorage()
        reply(result)
      }, () => reply({ error: 'DELETE_FAILED' }))
  }
}
