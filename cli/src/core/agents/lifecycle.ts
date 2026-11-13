/**
 * Stopping, purging and resuming an agent: the archive side of its lifecycle. Stop keeps the
 * conversation on disk to come back to; purge erases it; resume brings a stopped agent back.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import type { clearDeleted as clearDeletedFn, markDeleted as markDeletedFn } from '../../lib/deletedSessions.js'
import { PurgeAgentService, type PurgeDeps } from '../../lib/purgeAgentService.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import { createResumeAgentService, type ResumeAgentServiceDeps } from '../../lib/resumeAgentService.js'
import { moveHeldLine } from '../../lib/hostMove/moveAgent.js'
import type { SessionCheckpointStore } from '../../lib/sessionCheckpoint.js'
import type { StoppedAgentStore } from '../../lib/stoppedAgents.js'
import { AgentStopError, createStopAgentService, type StopAgentServiceDeps } from '../../lib/stopAgentService.js'
import { IdentityReadUnavailable } from '../../engines/kit/identityScan.js'

import type { AgentBrowserPort, BrowserSwitch } from '../api.js'
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
  /** A purge's other records of the harness. Its told lines in the agent ledger, which the agent cleanup erases in the
   *  edge host (core/api.ts `AgentCleanupPort.forgetTold`), before anything of the harness is deleted here
   *  (purgeAgentService.ts `eraseFirst`): false refuses the purge with nothing deleted. */
  forgetTold: (agentId: string) => Promise<boolean>
  /** And the requests of the creates that made it (lib/agentCreationReceipt.ts), after its conversation
   *  (`eraseRecords`): rejecting refuses the purge. */
  scrubCreated: (agentId: string) => Promise<unknown>
  /** To every connected window. */
  send: (frame: { type: string; payload: Record<string, unknown> }) => void
  pinnedControls: ResumeAgentServiceDeps['pinnedControls']
  retainExitedSession: ResumeAgentServiceDeps['retainExitedSession']
  announceSession: ResumeAgentServiceDeps['announceSession']
  relaunchOverrides: ResumeAgentServiceDeps['relaunchOverrides']
  prepareSessionResume: ResumeAgentServiceDeps['prepareSessionResume']
  stopBackgroundJob?: ResumeAgentServiceDeps['stopBackgroundJob']
  refreshGridWebSearch: ResumeAgentServiceDeps['refreshGridWebSearch']
  attachDsh: ResumeAgentServiceDeps['attachDsh']
  attachBrowser?: ResumeAgentServiceDeps['attachBrowser']
  attachSession: ResumeAgentServiceDeps['attachSession']
  relaunchMarks?: ResumeAgentServiceDeps['relaunchMarks']
  /** An agent was stopped: closed (`agent_close`), Stop Harness, or purged. The harnesses it started close with it
   *  (services/agentCleanup.ts `closed`). Its browser hears it from the forget the stop ends with
   *  (`createAgentBrowserLifecycle`), as for every other way an agent ends. */
  stopped?: (agentId: string) => void
  /** An agent was purged: its conversation is gone for good, and with it its agent browser's profile
   *  (services/agentBrowser.ts `deleted`). A stop keeps the profile, so the login survives a resume. */
  purged?: (agentId: string) => void
  /** An agent a move a dead daemon left may still run beside (main.ts `moveHeld`): no engine of it starts this start. */
  moveHeld?: (agentId: string) => boolean
}

/** What a delete says when the harness's told lines could not be erased: asked first, so nothing of it has gone. The
 *  delete adds what to do (lib/purgeAgentService.ts: the harness is stopped, refresh and try again). */
export const TOLD_NOT_ERASED = 'Harness could not erase what this harness was told, so nothing was deleted.'

export function createAgentLifecycle({
  registry, stoppedAgents, restartJobs, createBackend, noBackendCode, backendFor, agentReconciler, forgetSession, markDeleted, clearDeleted, stopNative, settlePane, cancelExternal,
  sessionCheckpoints, mirror, sessionSearch, forgetTold, scrubCreated, send, pinnedControls, retainExitedSession, announceSession,
  relaunchOverrides, prepareSessionResume, stopBackgroundJob, refreshGridWebSearch, adoptSwarmSkill, attachDsh, attachBrowser, attachSession, relaunchMarks, stopped, purged, atFolderTrust, atEmptyComposer, moveHeld,
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
    return stop(target, options).then(() => { stopped?.(agentId) })
  }
  const purgeAgentService = new PurgeAgentService({
    live: id => registry.byAgent(id), sessions: () => [...registry.list(), ...stoppedAgents.list()],
    stopped: stoppedAgents, checkpoints: sessionCheckpoints, stop: stopAgent,
    restarting: id => restartJobs.busy(id) || stopJobs.has(id),
    atFolderTrust,
    atEmptyComposer,
    // The person reads what was not erased; the cleanup's log has why (services/agentCleanup.ts).
    eraseFirst: async (s) => { if (!await forgetTold(s.agentId)) throw new Error(TOLD_NOT_ERASED) },
    eraseRecords: async (s) => { await scrubCreated(s.agentId) },
    deleted: s => {
      // Every conversation the harness had: a run that moved on (`/new`) leaves nothing under its earlier keys.
      const keys = [s.sessionId, ...(s.earlierSessionIds ?? [])].filter(Boolean)
      for (const key of keys) { mirror.deleteHistory(key); sessionSearch?.deleteHistory(key) }
      registry.deleteSavedNames([s.agentId, ...keys])
      send({ type: 'agent_deleted', payload: { agentId: s.agentId, retained: false } })
      purged?.(s.agentId)
    },
  })

  const resume = createResumeAgentService({
    registry, stoppedAgents, createBackend, noBackendCode, backendFor, restartJobs, stopJobs, pinnedControls,
    retainExitedSession, announceSession, relaunchOverrides, prepareSessionResume, stopBackgroundJob, adoptSwarmSkill,
    refreshGridWebSearch, clearDeleted, attachDsh, attachBrowser, attachSession, relaunchMarks,
  })
  const resumeAgent: ResumeAgent = (id, permissionMode, launchArgs) => {
    // A pane a stopped move left may still run this conversation's engine, which no record names (its pid was never
    // the row's), so a resume would find the engine gone and start a second one beside it: not this start.
    const heldId = (stoppedAgents.get(id) ?? registry.byAgent(id))?.agentId ?? id
    if (moveHeld?.(heldId)) {
      console.warn(moveHeldLine(heldId))
      return Promise.resolve({ ok: false, error: 'AGENT_BUSY', detail: 'This harness is held until the daemon restarts.' })
    }
    return resumeChecked(id, permissionMode, launchArgs)
  }
  const resumeChecked: ResumeAgent = (id, permissionMode, launchArgs) => (stoppedAgents.get(id) ?? registry.byAgent(id))?.guest
    ? Promise.resolve(GUEST_HARNESS_REFUSAL)
    : purgeAgentService.busy(id) || purgeAgentService.blocksFolder(stoppedAgents.get(id)?.cwd)
      ? Promise.resolve({ ok: false, error: 'AGENT_BUSY' }) : resume(id, permissionMode, launchArgs)
  return { stopJobs, stopAgent, purgeAgentService, resumeAgent }
}

/**
 * The agent browser (services/agentBrowser.ts) as its agent starts and ends here. `ended` is reached from every
 * way an agent stops running: a stop, a purge and every other forget (agents/forget.ts), and an engine that exits
 * or crashes by itself (lib/retainExitedSession.ts). Only a stop used to tell the browser, so the 2 GB container of
 * an agent whose engine exited on its own kept running and held a limit slot (review, 2026-11-10). One end is
 * seen more than once (an exit, then the forget of the same id), so the browser is told once per start.
 *
 * `set` is its person's Start and Stop, which the agent browser asks of the core (`CoreApi.agents.setBrowser`): the
 * row's flag, then the browser's own start or stop, in one turn, so the flag changes in the order the service's
 * queue asked. A browser left on comes back when its agent runs again; one turned off does not.
 *
 * How it comes back (decision 14): create, resume and daemon start attach it at once, before the engine is seen, so
 * the browser starts with its agent. Every other path is caught at the next scan: the reconciler's look at each
 * running agent (agents/discovery.ts `onObserved`) says `observed`. Only those three paths were handed `attached`, so
 * an agent back from the archive (a restore that could not see its engine, or two missed scans) ran on with its flag
 * set and no browser, and its Browser button was gone for good (a teammate's Mac, released build, 2026-11-11).
 *
 * The one case a flag changes id (decision 19): a new agent takes the pane its previous agent ended in (agents/
 * discovery.ts: an engine typed into the shell an exit left, or a scan that opens a new agent over a bound one).
 * `taken` tells the browser both ids; the agent browser moves the settings entry and its profile first, in its queue,
 * and then asks `move` (`CoreApi.agents.moveBrowser`), so a move that fails there leaves both flags as they were.
 * [stopped] is where a stopped agent's flag is written: the agent that ended is stopped by then, and so may the new one
 * be.
 */
export function createAgentBrowserLifecycle(
  browser: () => Pick<AgentBrowserPort, 'attached' | 'stopped' | 'moved'> | null,
  rows: { byAgent(agentId: string): RegisteredSession | undefined; setBrowser(agentId: string, on: boolean): RegisteredSession | null },
  stopped: Pick<StoppedAgentStore, 'get' | 'patch'>,
) {
  // Only agents whose Browser is on that run here: bounded by them, not by every agent the daemon ever saw.
  const running = new Set<string>()
  const attached = (session: RegisteredSession): void => {
    if (session.browser) running.add(session.agentId)
    browser()?.attached(session)
  }
  const ended = (agentId: string): void => {
    if (running.delete(agentId)) browser()?.stopped(agentId)
  }
  // Said on every scan of every running agent, while the daemon is idle: a browser already attached costs one lookup.
  const observed = (session: RegisteredSession): void => {
    if (session.browser && !running.has(session.agentId)) attached(session)
  }
  return {
    attached,
    ended,
    observed,
    set(agentId: string, on: boolean): BrowserSwitch {
      const row = rows.byAgent(agentId)
      if (!on) {
        // A Stop of a browser that is off, or of an agent gone since, is done already.
        if (!row?.browser) return { ok: true, changed: false }
        rows.setBrowser(agentId, false)
        ended(agentId)
        return { ok: true, changed: true }
      }
      if (!row) return { error: 'NOT_RUNNING' }
      // The machine's Podman, memory and network are its owner's: never a guest's agent's.
      if (row.guest) return { error: 'NOT_ALLOWED' }
      const changed = !row.browser
      // The row byAgent just gave, in the same turn: it is still live. Every Start attaches, as every look at an agent
      // does (`AgentBrowserPort.attached` is idempotent).
      attached(rows.setBrowser(agentId, true)!)
      return { ok: true, changed }
    },
    /** [to] took the pane [from] ended in. A guest's agent gets nothing of the owner's; one whose Browser is on keeps its
     *  own, and [from] keeps its flag and its logins. No flag changes here. */
    taken(from: string, to: RegisteredSession, on: boolean): void {
      if (to.guest || to.browser) return
      browser()?.moved(from, to, on)
    },
    /** The agent browser moved [from]'s entry to [to], and [from]'s Browser was on: the flag follows it. */
    move(from: string, to: string): BrowserSwitch {
      const live = rows.byAgent(to)
      if (!live && !stopped.get(to)) return { error: 'NOT_RUNNING' }
      // [from] runs again only if it was resumed since; an evicted agent is in neither list, and has nothing to clear.
      const back = rows.byAgent(from)
      const record = back ? null : stopped.get(from)
      if (record) stopped.patch(from, { browser: undefined })
      if (!live) {
        // Its resume brings the browser. A record that cannot be written puts [from]'s back: whole or not at all.
        try { stopped.patch(to, { browser: true }) } catch (error) {
          if (record) stopped.patch(from, { browser: record.browser })
          throw error
        }
      }
      if (back) {
        rows.setBrowser(from, false)
        ended(from)
      }
      if (live) attached(rows.setBrowser(to, true)!)
      return { ok: true, changed: true }
    },
  }
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
