/**
 * Stopping, purging and resuming an agent: the archive side of its lifecycle. Stop keeps the
 * conversation on disk to come back to; purge erases it; resume brings a stopped agent back.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import type { clearDeleted as clearDeletedFn, markDeleted as markDeletedFn } from '../../lib/deletedSessions.js'
import { LEAD_PROTECTED_DETAIL } from '../../lib/closeAgentService.js'
import { PurgeAgentService } from '../../lib/purgeAgentService.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import { createResumeAgentService, type ResumeAgentServiceDeps } from '../../lib/resumeAgentService.js'
import { moveHeldLine } from '../../lib/hostMove/moveAgent.js'
import type { SessionCheckpointStore } from '../../lib/sessionCheckpoint.js'
import type { StoppedAgentStore } from '../../lib/stoppedAgents.js'
import { AgentStopError, createStopAgentService, type StopAgentServiceDeps } from '../../lib/stopAgentService.js'
import { IdentityReadUnavailable } from '../../engines/kit/identityScan.js'

import type { ResumeAgent } from './launches.js'
import { GUEST_HARNESS_REFUSAL } from '../guestPolicy.js'

export interface LifecycleDeps {
  adoptSwarmSkill?: ResumeAgentServiceDeps['adoptSwarmSkill']
  settlePane?: StopAgentServiceDeps['settlePane']
  cancelExternal?: StopAgentServiceDeps['cancelExternal']
  registry: typeof registry
  stoppedAgents: StoppedAgentStore
  restartJobs: StopAgentServiceDeps['restartJobs']
  /** Where a resumed harness's new pane is made. */
  createBackend: ResumeAgentServiceDeps['createBackend']
  /** What a resume answers when [createBackend] is null (terminalBackend.ts `noBackendCode`). */
  noBackendCode?: ResumeAgentServiceDeps['noBackendCode']
  /** The backend that holds a pane (`terminals.backendFor`): stop closes, and resume asks about, each pane on its own. */
  backendFor: (runtime: Parameters<StopAgentServiceDeps['backendFor']>[0]) =>
    (ReturnType<StopAgentServiceDeps['backendFor']> & ReturnType<ResumeAgentServiceDeps['backendFor']>) | undefined
  agentReconciler: StopAgentServiceDeps['agentReconciler']
  forgetSession: StopAgentServiceDeps['forgetSession']
  stopNative: StopAgentServiceDeps['stopNative']
  /** Whether a fresh read of the agent's pane shows its engine waiting at the folder-trust question (main.ts reads the screen). */
  atFolderTrust?: (session: RegisteredSession) => Promise<boolean>
  /** The same, for an idle pane with an empty composer (a restored agent that never started a conversation). */
  atEmptyComposer?: (session: RegisteredSession) => Promise<boolean>
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
  /** An agent was stopped: closed (`agent_close`), Stop Harness, or purged. The harnesses it started close with it
   *  (services/agentCleanup.ts `closed`). */
  stopped?: (agentId: string) => void
  /** An agent a move a dead daemon left may still run beside (main.ts `moveHeld`): no engine of it starts this start. */
  moveHeld?: (agentId: string) => boolean
  /** Whether the agent is the Lead of an active Swarm project here (superTabs/retention.ts `retainedLeads`). */
  leadProtected?: (agentId: string) => boolean
}

/** The owner, 2026-10-23: the Lead of an active project is never stopped, in any case; deleting its project closes it. */
export class LeadProtectedError extends Error {
  readonly code = 'LEAD_PROTECTED'
  constructor() { super(LEAD_PROTECTED_DETAIL) }
}

export function createAgentLifecycle({
  registry, stoppedAgents, restartJobs, createBackend, noBackendCode, backendFor, agentReconciler, forgetSession, markDeleted, clearDeleted, stopNative, settlePane, cancelExternal,
  sessionCheckpoints, mirror, sessionSearch, send, pinnedControls, retainExitedSession, announceSession,
  relaunchOverrides, prepareSessionResume, refreshGridWebSearch, adoptSwarmSkill, attachDsh, attachSession, relaunchMarks, stopped, atFolderTrust, atEmptyComposer, moveHeld,
  leadProtected,
}: LifecycleDeps) {
  /**
   * Stop Harness (`agent_delete`) archives its conversation and launch settings, removes the live
   * registry entry, and closes only its exact panes, each on its own backend. Exact PID/start-marker validation guards the engine's
   * SIGTERM/SIGKILL fallback. Engine conversation files, recaps and the Harness name remain on disk.
   */
  const stopJobs = new Map<string, Promise<void>>()
  const stop = createStopAgentService({
    registry, stoppedAgents, restartJobs, stopJobs, backendFor, agentReconciler,
    forgetSession, markDeleted, clearDeleted, stopNative, settlePane, cancelExternal,
  })
  /**
   * Every stop goes through here: a window's close and Stop Harness, `harness close`, a purge. Told once the stop is
   * done, never while it can still fail: a harness closed takes the harnesses it started with it, so none of them
   * goes on working, spending the person's tokens, for a starter that will never read it (owner, October 12).
   */
  const stopAgent: typeof stop = (target, options) => {
    const agentId = registry.resolve(target)?.agentId ?? target
    if (leadProtected?.(agentId)) return Promise.reject(new LeadProtectedError())
    return stop(target, options).then(() => { stopped?.(agentId) })
  }
  const purgeAgentService = new PurgeAgentService({
    live: id => registry.byAgent(id), sessions: () => [...registry.list(), ...stoppedAgents.list()],
    stopped: stoppedAgents, checkpoints: sessionCheckpoints, stop: stopAgent,
    restarting: id => restartJobs.busy(id) || stopJobs.has(id),
    atFolderTrust,
    atEmptyComposer,
    deleted: s => {
      if (s.sessionId) { mirror.deleteHistory(s.sessionId); sessionSearch?.deleteHistory(s.sessionId) }
      registry.deleteSavedNames([s.agentId, s.sessionId].filter(Boolean))
      send({ type: 'agent_deleted', payload: { agentId: s.agentId, retained: false } })
    },
  })

  const resume = createResumeAgentService({
    registry, stoppedAgents, createBackend, noBackendCode, backendFor, restartJobs, stopJobs, pinnedControls,
    retainExitedSession, announceSession, relaunchOverrides, prepareSessionResume, adoptSwarmSkill,
    refreshGridWebSearch, clearDeleted, attachDsh, attachSession, relaunchMarks,
  })
  const resumeAgent: ResumeAgent = (id, permissionMode) => {
    // A pane a stopped move left may still run this conversation's engine, which no record names (its pid was never
    // the row's), so a resume would find the engine gone and start a second one beside it: not this start.
    const heldId = (stoppedAgents.get(id) ?? registry.byAgent(id))?.agentId ?? id
    if (moveHeld?.(heldId)) {
      console.warn(moveHeldLine(heldId))
      return Promise.resolve({ ok: false, error: 'AGENT_BUSY', detail: 'This harness is held until the daemon restarts.' })
    }
    return resumeChecked(id, permissionMode)
  }
  const resumeChecked: ResumeAgent = (id, permissionMode) => (stoppedAgents.get(id) ?? registry.byAgent(id))?.guest
    ? Promise.resolve(GUEST_HARNESS_REFUSAL)
    : purgeAgentService.busy(id) || purgeAgentService.blocksFolder(stoppedAgents.get(id)?.cwd)
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
      if (error instanceof IdentityReadUnavailable) return { error: error.code, detail: error.message, held: true, retryable: true }
      if (!(error instanceof AgentStopError) && !(error instanceof LeadProtectedError)) throw error
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
