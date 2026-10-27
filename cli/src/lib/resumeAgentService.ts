/** Exact-resume lifecycle shared by the daemon and its isolated acceptance tests. */
import type { AdoptSwarmSkill } from '../core/agents/swarmSkills.js'
import { transcriptSize, type RelaunchMarks } from '../core/transcripts/relaunch.js'
import { isTerminalEngine } from '../engines/types.js'
import { installedDsh } from '../dsh/installed.js'
import { engineKeepsTranscriptFile, registry as liveRegistry, type RegisteredSession } from './registry.js'
import { controlTranscriptEvidence } from '../engines/transcriptBindings.js'
import { materializeResumeTranscript } from '../engines/resumeTranscript.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { ResumePreparationError } from '../engines/kit/resumeRepair.js'
import type { StoppedAgentStore } from './stoppedAgents.js'
import { resumeStoppedAgent, waitForResumedAgent, resumeChanged, resumeUnconfirmed, RESUME_READINESS_BUDGET_MS } from './resumeStoppedAgent.js'
import { checkPidRuntime } from './deleteAgentFallback.js'
import { checkSessionRuntime, resolvePaneEngineProcess } from './paneEngineProcess.js'
import { engineBin, enginePathOverride } from './engineBin.js'
import { engineInstallRecipe } from './engineInstall.js'
import { stopConflictingBackgroundJob } from './claudeBackgroundJob.js'
import { buildEngineLaunchArgv, dropPermissionFlagIfUnsupported, engineLaunchEnv, permissionModeApproves, permissionModeFlags, refusePermissionFlagIfUnsupported } from './engineLaunch.js'
import { workspaceMissing } from './workspaceCheck.js'
import { buildHarnessSessionLabel } from './harnessSessionLabel.js'
import { createAndRegisterPane, type CreateAgentPaneDeps } from './createAgentPane.js'
import type { LaunchOverrides, LaunchOverridesResult } from './launchOverrides.js'
import type { AgentRestartCoordinator } from './restartAgent.js'
import { missingBackendCode, terminalTargetOf, type TerminalBackend } from './terminalBackend.js'
import { windowsLaunchRefusal } from './windows/launch.js'
import { isWindowsHeldPane, windowsPaneLaunch } from './windows/engineStart.js'
import { sameTerminalPlacement } from './terminalRuntime.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'
import { harnessPermissionEnvironment } from './harnessDefaults.js'

export interface ResumeAgentServiceDeps {
  adoptSwarmSkill?: AdoptSwarmSkill
  registry: Pick<typeof liveRegistry, 'byAgent' | 'bySession' | 'resumePendingAgent' | 'setLaunch' | 'updateProcessIdentity'>
  stoppedAgents: StoppedAgentStore
  /** Where a resumed harness's new pane is made (main.ts `createBackend`); null with no backend ready. */
  createBackend: (CreateAgentPaneDeps['tmuxBackend'] & Pick<TerminalBackend, 'releaseHold'>) | null
  /** What a resume answers when [createBackend] is null: the configured backend's own code (terminalBackend.ts
   *  `noBackendCode`); `TMUX_UNAVAILABLE`, as before, by default. */
  noBackendCode?: string
  /** The backend that holds [runtime] (`terminals.backendFor`): a pane is asked about on its own backend, tmux's
   *  first on a row that has one (`terminalTargetOf`). */
  backendFor(runtime: TerminalRuntimeRef): Pick<TerminalBackend, 'paneState' | 'rootProcess' | 'inventory' | 'releaseHold'> | undefined
  restartJobs: AgentRestartCoordinator
  stopJobs: ReadonlyMap<string, Promise<void>>
  pinnedControls: { has(agentId: string): boolean }
  retainExitedSession(session: RegisteredSession, paneAlive: boolean): void
  announceSession(session: RegisteredSession): void
  relaunchOverrides(session: RegisteredSession, source: RegisteredSession, current: () => boolean): Promise<LaunchOverridesResult>
  prepareSessionResume(session: RegisteredSession): void
  refreshGridWebSearch(agentId: string, overrides: LaunchOverrides): void
  clearDeleted(agentId: string): void
  attachDsh(session: RegisteredSession): void
  /** Follows a session: its history read, then its tail (core/transcripts/attach.ts). */
  attachSession(session: RegisteredSession): Promise<boolean>
  /** Where the relaunched engine's own writing begins, for the attach that follows (core/transcripts/relaunch.ts). */
  relaunchMarks?: Pick<RelaunchMarks, 'note'>
}

/** A history that could not be prepared, and which check refused it: on 2026-10-26, 10 of 17 failed resumes were
 *  this and nothing said why. The kind goes in the reply for its counter; the message of a typed failure (an engine's
 *  file label and a line number, never conversation text) only to this daemon's log. Any other error is logged by
 *  its class alone: its message can carry a profile path, a token or a line of the conversation (review of #1777). */
function preparationFailed(agent: string, error: unknown) {
  const reason = error instanceof ResumePreparationError ? error.kind : 'other'
  const said = error instanceof ResumePreparationError ? error.message : error instanceof Error ? error.name : typeof error
  console.warn(`[resume] ${agent} · resume preparation failed: ${reason}: ${said}`)
  return { ok: false as const, error: 'RESUME_PREPARATION_FAILED', reason,
    detail: reason === 'changed_during' ? 'Codex is still writing this conversation. Try again once it stops.'
      : 'Could not prepare the saved conversation. Its history has been retained.' }
}

export function createResumeAgentService(deps: ResumeAgentServiceDeps) {
  const { registry, stoppedAgents, createBackend, noBackendCode = 'TMUX_UNAVAILABLE', backendFor, restartJobs, stopJobs, pinnedControls,
    retainExitedSession, announceSession, relaunchOverrides, prepareSessionResume, adoptSwarmSkill,
    refreshGridWebSearch, clearDeleted, attachDsh, attachSession, relaunchMarks } = deps
  const resumeConversations = new Set<string>()
  /** Same short form every other `[…]` line in the daemon logs uses. */
  const sid = (id: string) => id.slice(0, 8)

  /**
   * A reservation nothing can still be using, taken over.
   *
   * `beginResume` reserves an agent before tmux allocation so that a crash in the window between
   * allocating a pane and persisting its row cannot be followed by a second process for the same
   * conversation. It is deliberately NOT released on an unverified outcome — which is right, and
   * which also means a reservation whose owner died leaves the harness unresumable for good: every
   * later Enter is refused before it looks at anything, with "the saved conversation has not been
   * confirmed yet" over a harness nobody is confirming.
   *
   * Age settles it. The readiness wait is the longest a resume can legitimately hold this, so an
   * older reservation belongs to an operation that is over. By then the crash window it guards is
   * closed too: a pane that outlived it has had many reconcile passes to be discovered, given a row
   * and bound to its conversation, and `canLaunch` — which has already returned true to get here —
   * checks both the registry and the saved process before any of this runs.
   */
  const retakeStaleReservation = (agentId: string): string | null => {
    const heldSince = stoppedAgents.resumeReservedAt(agentId)
    if (heldSince === null || Date.now() - heldSince <= RESUME_READINESS_BUDGET_MS) return null
    console.log(`[resume] ${sid(agentId)} taking over a reservation held since ${new Date(heldSince).toISOString()} · its owner is gone`)
    stoppedAgents.finishResume(agentId)
    return stoppedAgents.beginResume(agentId)
  }
  const waitForResume = async (entry: RegisteredSession, current: () => boolean) => {
    // Registry observations may update the same object; pin the route being verified.
    const saved = { ...entry }
    const ownsRoute = () => current() && registry.byAgent(saved.agentId)?.tmuxPane === saved.tmuxPane
    // A resume to confirm runs in one of the row's panes, asked of the backend it is on (tmux's first). One with no
    // pane on a backend here is not confirmed here: the code names the backend missing (TMUX_UNAVAILABLE for tmux).
    const target = terminalTargetOf(saved, backendFor)
    if (!target) return { ok: false as const, error: missingBackendCode(saved) }
    const { backend: terminal, runtime } = target
    // A second look at an unconfirmed resume: the verdict is withdrawn before the check, or the
    // readiness probe would return it straight back. The desk sees the tile leave "Start failed".
    const unconfirmed = ownsRoute() ? registry.byAgent(saved.agentId) : undefined
    if (unconfirmed?.launch?.state === 'failed' && unconfirmed.launch.error === 'RESUME_UNCONFIRMED') {
      // No await separates the verified row above from this synchronous update.
      announceSession(registry.setLaunch(saved.agentId, { state: 'starting' })!)
    }
    const result = await waitForResumedAgent(saved, {
      current: ownsRoute,
      session: () => registry.byAgent(saved.agentId),
      process: () => resolvePaneEngineProcess(terminal, runtime, saved.engine),
      pane: () => terminal.paneState(runtime),
      sleep: ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() }),
    })
    if (!ownsRoute()) return resumeChanged
    if (result.ok) {
      // A probe proves the new PID but does not publish it. Persist that proof before readiness;
      // an engine whose hook is delayed or absent must still be attachable and stoppable now.
      if (!result.session.processIdentity
        || !registry.updateProcessIdentity(saved.agentId, result.session.processIdentity)) return resumeChanged
      await terminal.releaseHold(runtime)
      if (!ownsRoute()) return resumeChanged
      stoppedAgents.finishResume(saved.agentId)
      // Whoever got there first wins, and if nobody did, this does: a hook that already reached
      // `register` has marked the row ready, and a resume confirmed by its process alone has nothing
      // else coming. A row left `starting` reads as "Starting" for ever, is made dormant without
      // being retained by discovery's `onExited`, and is refused by the desk's own resume receipt —
      // asking WHICH proof confirmed it got that wrong in both directions, so ask the row instead.
      // `ownsRoute()` read this row just above, and nothing since has yielded: it is still registered.
      const confirmed = registry.byAgent(saved.agentId)!
      const ready = confirmed.launch?.state === 'ready'
        ? confirmed
        : registry.setLaunch(saved.agentId, { state: 'ready' })!
      const hooked = confirmed.lastHookAt > 0
      console.log(`[resume] ${sid(saved.agentId)} confirmed · engine=${saved.engine}`
        + ` · hook=${hooked ? 'yes' : 'no'} · ${result.resumed ? 'same conversation' : 'fresh'}`)
      announceSession(ready)
      // Confirmed by its own process, the conversation is followed whether or not a hook ever comes.
      // Only the hook's registration attached it: discovery attaches a row it finds still launching,
      // and this one is ready already. With its SessionStart refused (round 23: the hook beat the
      // process being recorded) or never sent, nothing attached it, and the resumed agent never showed
      // a turn. A hook that registers later attaches it again, as one does a created agent. Only the
      // conversation it reopened: a resume that started a new one has nothing to follow until the engine
      // names it, and the row's old conversation is not being written any more.
      if (!hooked && result.resumed) {
        void attachSession(ready).catch((error) => {
          console.error(`[resume] ${sid(saved.agentId)} attach failed:`, error instanceof Error ? error.message : error)
        })
      }
      return { ...result, session: ready }
    } else if (result.error !== 'AGENT_CHANGED') {
      const row = registry.byAgent(saved.agentId)!
      const failed = registry.setLaunch(row.agentId, { state: 'failed', error: result.error, detail: result.detail })
      // Logged like the confirmation above, and for the same reason: this verdict clears `active`,
      // makes the desk refuse to open the harness, and is the one a person comes asking about —
      // openharness#189 was hard to place precisely because the resume path said nothing either way.
      console.log(`[resume] ${sid(saved.agentId)} ${result.error} · engine=${saved.engine}${result.detail ? ` · ${result.detail}` : ''}`)
      announceSession(failed!)
      // A verified exit releases the reservation and keeps the shell/output. Unknown startup
      // keeps both runtime and reservation; another Enter cannot launch a duplicate process.
      if (result.error === 'RESUME_FAILED' && (await checkPidRuntime(row)).state === 'gone') {
        if (!ownsRoute()) return resumeChanged
        const pane = await terminal.paneState(runtime)
        if (!ownsRoute()) return resumeChanged
        // Only a pane known to be gone or dead loses its row. One tmux could not read keeps it, as a
        // terminal: the reconciler removes it once its scans agree the pane is gone.
        retainExitedSession(row, pane === 'unknown' || (pane !== 'gone' && !pane.dead))
        stoppedAgents.finishResume(saved.agentId)
      }
    }
    return result
  }

  const resumeStopped = (agentId: string, current: () => boolean, permissionMode?: string) => resumeStoppedAgent({
    live: () => registry.byAgent(agentId),
    saved: () => stoppedAgents.get(agentId),
    current,
    checkLive: async entry => {
      // Its own pane on the backend it is on, tmux's first. A row with none on a backend here cannot be checked.
      const target = terminalTargetOf(entry, backendFor)
      if (!target) return { state: 'unknown', reason: 'Terminal inventory is unavailable.' }
      const { backend: terminal, runtime } = target
      const inventory = await terminal.inventory()
      if (inventory.state !== 'available') return { state: 'unknown', reason: 'Terminal inventory is unavailable.' }
      const paneAlive = inventory.roots.some(root => sameTerminalPlacement(root.runtime, runtime))
      if (isTerminalEngine(entry.engine)) return paneAlive ? { state: 'alive' } : { state: 'gone', reason: 'Shell pane is gone.' }
      const process = await checkPidRuntime(entry)
      if (process.state !== 'gone') {
        if (!paneAlive || process.state === 'unknown') return { state: 'unknown', reason: 'The previous process is not available through its saved terminal.' }
        return checkSessionRuntime(terminal, entry, runtime)
      }
      if (!entry.processIdentity && paneAlive) return { state: 'unknown', reason: 'The engine has not been identified yet.' }
      return process
    },
    retain: async entry => {
      // Its own pane, on the backend it is on: a row with none on a backend here cannot be verified, as with no tmux.
      const target = terminalTargetOf(entry, backendFor)
      const inventory = target && await target.backend.inventory()
      if (inventory?.state !== 'available') throw new Error('Could not verify the previous terminal. Try again.')
      if (!current()) return
      const { runtime } = target!
      retainExitedSession(entry, inventory.roots.some(root => sameTerminalPlacement(root.runtime, runtime)))
    },
    waitForReady: saved => waitForResume(saved, current),
    canLaunch: async saved => {
      await stopJobs.get(agentId)
      return !registry.bySession(saved.sessionId) && (await checkPidRuntime(saved)).state === 'gone'
    },
    launch: async (saved, resumeSessionId) => {
      // As a create with no backend ready answers (core/agents/create.ts).
      if (!createBackend) return { ok: false, error: noBackendCode }
      // An explicit change is checked before allocating anything, and is persisted with the
      // resumed row. Ordinary Open keeps the saved mode, including the older-engine fallback.
      if (permissionMode !== undefined) {
        if (!permissionModeFlags(saved.engine, permissionMode)) return { ok: false, error: 'INVALID_PERMISSION_MODE' }
        const choice = { permissionMode, bypassPermission: permissionModeApproves(permissionMode) }
        saved = { ...saved, ...choice }
      }
      if (saved.grid && !saved.gridLaunch) return { ok: false, error: 'GRID_CREDENTIAL_REQUIRED', detail: 'The saved provider configuration is unavailable.' }
      if (saved.dsh && !installedDsh(saved.dsh)) return { ok: false, error: 'INVALID_DSH', detail: 'Install this harness from the Harness Store before resuming it.' }
      if (!saved.cwd) return { ok: false, error: 'CWD_NOT_FOUND', detail: 'The saved project folder is no longer available.' }
      const cwd = saved.cwd
      const missing = workspaceMissing(cwd)
      if (missing) return missing
      // Only for an engine whose conversation IS a file. opencode, kilo, hermes and devin keep
      // theirs in a database, so they have no transcript to point at and demanding one here refused
      // a resume that works — after the harness had already been paused.
      if (resumeSessionId && engineKeepsTranscriptFile(saved.engine) && !saved.transcriptPath) {
        return { ok: false, error: 'RESUME_UNAVAILABLE', detail: 'The saved conversation file is unavailable. Start a new conversation separately.' }
      }
      if (adoptSwarmSkill) {
        const adopted = await adoptSwarmSkill(saved, current)
        if (!adopted || !current()) return resumeChanged
        saved = adopted
      }
      const sourceEvidence = () => resumeSessionId && engineKeepsTranscriptFile(saved.engine)
        ? controlTranscriptEvidence(saved.engine, resumeSessionId, saved.transcriptPath!, saved.codexHome ?? undefined, saved.cwd) : undefined
      // Match the registry's globally unique conversation index, including aliases/profiles.
      const key = saved.sessionId || saved.agentId
      if (resumeConversations.has(key)) return { ok: false, error: 'AGENT_BUSY' }
      resumeConversations.add(key)
      let token: string | null = null
      let allocationAttempted = false
      try {
        // Reserve before materializing cold history too: two Open requests must not rewrite a
        // conversation an earlier, unconfirmed allocation might still be using.
        token = stoppedAgents.beginResume(agentId)
        if (!token) token = retakeStaleReservation(agentId)
        if (!token) return resumeUnconfirmed
        if (resumeSessionId && saved.transcriptPath) {
          saved = { ...saved, transcriptPath: await materializeResumeTranscript(saved.engine, resumeSessionId,
            saved.transcriptPath, saved.codexHome ?? undefined, () => current() && !registry.bySession(saved.sessionId)) }
          if (!current()) return resumeChanged
        }
        let transcript = sourceEvidence()
        if (transcript) saved = { ...saved, transcriptPath: transcript.path }
        let sourceError: unknown
        const sourceCurrent = () => {
          if (!current() || sourceError) return false
          if (saved.sessionId && registry.bySession(saved.sessionId)) {
            sourceError = new IdentityReadUnavailable('another live harness owns this conversation')
            return false
          }
          try { transcript?.verify(); return true }
          catch (error) { sourceError = error; return false }
        }
        const built = await relaunchOverrides(saved, saved, sourceCurrent)
        if (sourceError) throw sourceError
        transcript?.verify()
        if (!built.ok) return built
        if (!current()) return resumeChanged
        if (permissionMode !== undefined) {
          const refusal = await refusePermissionFlagIfUnsupported(saved.engine,
            { permissionMode, bypassPermission: permissionModeApproves(permissionMode) }, undefined, built.overrides.native)
          if (!sourceCurrent()) return resumeChanged
          if (refusal) return { ok: false, ...refusal }
        }
        if (resumeSessionId) {
          try { prepareSessionResume(saved) } catch (error) {
            if (error instanceof IdentityReadUnavailable) throw error
            return preparationFailed(sid(saved.agentId), error)
          }
          // The confirmed synchronous repair may atomically replace this file.
          // Earn a new proof of the same conversation before the next await.
          transcript = sourceEvidence()
        }
        if (saved.sessionId && registry.bySession(saved.sessionId)) return { ok: false, error: 'AGENT_BUSY' }
        // Everything the engine writes from here on is its own, and live: the attach after it folds the
        // conversation only up to this byte. Taken after the history is prepared, which can rewrite it.
        if (resumeSessionId && saved.sessionId && saved.transcriptPath) {
          const offset = transcriptSize(saved.transcriptPath)
          // A resume always starts a new engine: a turn left open before it is over.
          if (offset !== null) relaunchMarks?.note(saved.sessionId, offset, true)
        }
        const { extraArgs, clearEnv } = built.overrides
        const launchEnv = permissionMode === undefined ? built.overrides.env
          : harnessPermissionEnvironment(saved.engine, built.overrides.env, permissionMode)
        // The engine may have been downgraded since this harness was paused. Nobody is waiting on
        // the mode the way they are waiting on the harness, so the flag goes and the launch stays
        // (openharness#285). The row keeps its recorded mode; discovery re-derives the live one.
        const savedPermission = {
          permissionMode: saved.permissionMode ?? null,
          bypassPermission: saved.bypassPermission === true,
        }
        const { choice: permission, droppedFlag, nativeHold } = permissionMode === undefined
          ? await dropPermissionFlagIfUnsupported(saved.engine, savedPermission, undefined, built.overrides.native)
          : { choice: savedPermission, droppedFlag: null }
        transcript?.verify()
        if (!current()) return resumeChanged
        if (nativeHold || built.overrides.native?.current() === false) return { ok: false, error: 'NATIVE_LAUNCH_HELD', detail: nativeHold ?? 'Waiting for fresh executable and hook evidence.' }
        if (droppedFlag) {
          console.warn(`[resume] ${sid(saved.agentId)} · ${saved.engine} does not take ${droppedFlag}`
            + ` · resuming in Ask · update ${saved.engine} to get ${saved.permissionMode ?? 'Auto'} back`)
        }
        // Claude Code refuses `--resume` on a session a `claude --bg` job still has open ("that session
        // is running in the background … run `claude attach …` or `claude stop …` first"). Claude only.
        // `native` is the captured launch for every ordinary local Claude run (launchOverrides.ts), not
        // just grid — it is NOT a signal the pane is elsewhere, so it must not gate this off. A DSH
        // agent's pane is the one case that may run on a different host entirely, whose jobs store this
        // process cannot see (and must not touch).
        if (resumeSessionId && saved.engine === 'claude' && !saved.dsh) {
          // The exact environment the pane is about to get (built below as `paneEnv`): `launchEnv`
          // already carries a native launch's own CLAUDE_CONFIG_DIR (launchOverrides.ts merges
          // `native.environment` into it), and `engineLaunchEnv` adds Windows's own-process variables.
          await stopConflictingBackgroundJob({
            bin: engineBin(saved.engine), sessionId: resumeSessionId,
            env: { ...process.env, ...launchEnv, ...engineLaunchEnv(saved.engine, built.overrides.native) },
            log: message => console.log(`[resume] ${sid(saved.agentId)} ${message}`),
          })
          transcript?.verify()
          if (!current()) return resumeChanged
        }
        const options = {
          ...(built.overrides.native ? { native: built.overrides.native } : {}),
          resumeSessionId,
          bypassPermission: permission.bypassPermission === true,
          ...(permission.permissionMode ? { permissionMode: permission.permissionMode } : {}),
          cwd,
          ...(extraArgs.length ? { extraArgs } : {}),
          ...(clearEnv.length ? { clearEnv } : {}),
          ...(launchEnv.HARNESS_DSH ? { harnessNode: true } : {}),
          installIfMissing: enginePathOverride(saved.engine) ? undefined : engineInstallRecipe(saved.engine),
        }
        // Windows refuses a batch-file engine whose arguments cmd.exe would read (windows/launch.ts): this row alone.
        let argv: string[]
        try { argv = buildEngineLaunchArgv(saved.engine, options) } catch (error) { return windowsLaunchRefusal(error) }
        // Windows: the variables the argv's `/usr/bin/env` prefix carries elsewhere, last (engineLaunchEnv).
        const paneEnv = { ...launchEnv, ...engineLaunchEnv(saved.engine, built.overrides.native) }
        transcript?.verify()
        if (!current()) return resumeChanged
        clearDeleted(agentId)
        if (saved.sessionId) clearDeleted(saved.sessionId)
        // Only actual dispatch can leave an unknown allocation. A held backend
        // gate releases the reservation so recovery may retry without spawning twice.
        const result = await createAndRegisterPane({
          current: () => sourceCurrent() && built.overrides.native?.current() !== false,
          ...(built.overrides.native ? { nativeToken: built.overrides.native.token } : {}),
          onDispatch: () => { allocationAttempted = true },
          tmuxBackend: { ...createBackend, create: async request => {
            const result = await createBackend.create(request)
            if (result.dispatch !== 'not_started') allocationAttempted = true
            return result
          }, kill: runtime => createBackend.kill(runtime) },
          registry: { openPendingAgent: input => sourceCurrent() ? registry.resumePendingAgent(saved, input.runtimes, input.nativeToken) : null },
          maxAttempts: 1,
          engine: saved.engine,
          sessionLabel: buildHarnessSessionLabel(saved.engine),
          argv,
          // Windows: the workspace to start in and the shell the pane becomes after the engine (windows/engineStart.ts).
          paneLaunch: windowsPaneLaunch(saved.engine, { ...options, held: isWindowsHeldPane(argv) }),
          ...(Object.keys(paneEnv).length ? { env: paneEnv } : {}),
        })
        if (sourceError) throw sourceError
        if (!result.ok) {
          if (result.error === 'TMUX_UNAVAILABLE') {
            stoppedAgents.finishResume(agentId, token)
            return { ok: false, error: result.error, detail: result.detail }
          }
          return resumeUnconfirmed
        }
        const { pending, spawned } = result
        if (!current()) {
          // Stop may have completed while allocation was awaiting its tmux reply.
          // The newly claimed runtime still belongs to this cancelled operation.
          const killed = await createBackend.kill(spawned.runtime)
          if (killed.state === 'succeeded') {
            retainExitedSession(pending, false)
            stoppedAgents.finishResume(agentId, token)
          }
          return resumeChanged
        }
        refreshGridWebSearch(pending.agentId, built.overrides)
        announceSession(pending)
        if (isTerminalEngine(saved.engine)) {
          await createBackend.releaseHold(spawned.runtime)
          if (!current()) return resumeChanged
          const ready = registry.setLaunch(pending.agentId, { state: 'ready' })!
          stoppedAgents.finishResume(agentId, token)
          announceSession(ready)
          return { ok: true, session: ready, resumed: true }
        }
        if (pending.dsh) attachDsh(pending)
        return await waitForResume(pending, current)
      } catch (error) {
        if (error instanceof IdentityReadUnavailable) return { ok: false,
          error: allocationAttempted ? 'RESUME_UNCONFIRMED' : error.code, detail: error.message }
        throw error
      } finally {
        if (token && !allocationAttempted) stoppedAgents.finishResume(agentId, token)
        resumeConversations.delete(key)
      }
    },
  })

  return (agentId: string, permissionMode?: string) => restartJobs.run(agentId, async current => {
    await stopJobs.get(agentId)
    if (!current()) return resumeChanged
    if (pinnedControls.has(agentId)) return { ok: false, error: 'AGENT_BUSY' }
    const result = await resumeStopped(agentId, current, permissionMode)
    // Open may attach to an already running session. It must never claim to have changed that
    // process's permissions, including when another client started it during this request.
    if (result.ok && permissionMode !== undefined && result.session.permissionMode !== permissionMode) {
      return { ok: false, error: 'PERMISSION_CHANGE_REQUIRES_STOP', detail: 'Stop this harness before changing its permission mode.' }
    }
    return result
  }, permissionMode === undefined ? 'resume' : `resume:${permissionMode}`)

}
