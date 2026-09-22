/** Exact-resume lifecycle shared by the daemon and its isolated acceptance tests. */
import { isTerminalEngine } from '../engines/types.js'
import { installedDsh } from '../dsh/installed.js'
import { registry as liveRegistry, validTranscriptPath, type RegisteredSession } from './registry.js'
import type { StoppedAgentStore } from './stoppedAgents.js'
import { resumeStoppedAgent, waitForResumedAgent, resumeChanged, resumeUnconfirmed } from './resumeStoppedAgent.js'
import { checkPidRuntime } from './deleteAgentFallback.js'
import { checkSessionRuntime, clearPaneRemainOnExit, resolvePaneEngineProcess, tmuxPaneState } from './tmux.js'
import { listTmuxPanes } from './tmuxAgentDiscovery.js'
import { enginePathOverride } from './engineBin.js'
import { engineInstallRecipe } from './engineInstall.js'
import { buildEngineLaunchArgv } from './engineLaunch.js'
import { workspaceMissing } from './workspaceCheck.js'
import { buildHarnessSessionLabel } from './harnessSessionLabel.js'
import { createAndRegisterPane, type CreateAgentPaneDeps } from './createAgentPane.js'
import type { LaunchOverrides, LaunchOverridesResult } from './launchOverrides.js'
import type { AgentRestartCoordinator } from './restartAgent.js'

export interface ResumeAgentServiceDeps {
  registry: Pick<typeof liveRegistry, 'byAgent' | 'bySession' | 'resumePendingAgent' | 'setLaunch'>
  stoppedAgents: StoppedAgentStore
  tmuxBackend: CreateAgentPaneDeps['tmuxBackend'] | null
  restartJobs: AgentRestartCoordinator
  stopJobs: ReadonlyMap<string, Promise<void>>
  pinnedControls: { has(agentId: string): boolean }
  retainExitedSession(session: RegisteredSession, paneAlive: boolean): void
  announceSession(session: RegisteredSession): void
  relaunchOverrides(session: RegisteredSession): Promise<LaunchOverridesResult>
  prepareSessionResume(session: RegisteredSession): void
  refreshGridWebSearch(agentId: string, overrides: LaunchOverrides): void
  clearDeleted(agentId: string): void
  attachDsh(session: RegisteredSession): void
}

export function createResumeAgentService(deps: ResumeAgentServiceDeps) {
  const { registry, stoppedAgents, tmuxBackend, restartJobs, stopJobs, pinnedControls,
    retainExitedSession, announceSession, relaunchOverrides, prepareSessionResume,
    refreshGridWebSearch, clearDeleted, attachDsh } = deps
  const resumeConversations = new Set<string>()
  const waitForResume = async (entry: RegisteredSession, current: () => boolean) => {
    // Registry observations may update the same object; pin the route being verified.
    const saved = { ...entry }
    const ownsRoute = () => current() && registry.byAgent(saved.agentId)?.tmuxPane === saved.tmuxPane
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
      process: () => resolvePaneEngineProcess(saved.tmuxPane, saved.engine),
      pane: () => tmuxPaneState(saved.tmuxPane),
      sleep: ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() }),
    })
    if (!ownsRoute()) return resumeChanged
    if (result.ok) {
      await clearPaneRemainOnExit(saved.tmuxPane)
      if (!ownsRoute()) return resumeChanged
      stoppedAgents.finishResume(saved.agentId)
      announceSession(result.session)
    } else if (result.error !== 'AGENT_CHANGED') {
      const row = registry.byAgent(saved.agentId)!
      const failed = registry.setLaunch(row.agentId, { state: 'failed', error: result.error, detail: result.detail })
      announceSession(failed!)
      // A verified exit releases the reservation and keeps the shell/output. Unknown startup
      // keeps both runtime and reservation; another Enter cannot launch a duplicate process.
      if (result.error === 'RESUME_FAILED' && (await checkPidRuntime(row)).state === 'gone') {
        if (!ownsRoute()) return resumeChanged
        const pane = await tmuxPaneState(saved.tmuxPane)
        if (!ownsRoute()) return resumeChanged
        retainExitedSession(row, !!pane && !pane.dead)
        stoppedAgents.finishResume(saved.agentId)
      }
    }
    return result
  }

  const resumeStopped = (agentId: string, current: () => boolean) => resumeStoppedAgent({
    live: () => registry.byAgent(agentId),
    saved: () => stoppedAgents.get(agentId),
    current,
    checkLive: async entry => {
      if (!entry.tmuxPane) return { state: 'unknown', reason: 'Only tmux resume is supported.' }
      const inventory = await listTmuxPanes()
      if (!inventory.ok) return { state: 'unknown', reason: 'Terminal inventory is unavailable.' }
      const paneAlive = inventory.panes.some(pane => pane.tmuxPane === entry.tmuxPane)
      if (isTerminalEngine(entry.engine)) return paneAlive ? { state: 'alive' } : { state: 'gone', reason: 'Shell pane is gone.' }
      const process = await checkPidRuntime(entry)
      if (process.state !== 'gone') {
        if (!paneAlive || process.state === 'unknown') return { state: 'unknown', reason: 'The previous process is not available through its saved terminal.' }
        return checkSessionRuntime(entry)
      }
      if (!entry.processIdentity && paneAlive) return { state: 'unknown', reason: 'The engine has not been identified yet.' }
      return process
    },
    retain: async entry => {
      const inventory = await listTmuxPanes()
      if (!inventory.ok) throw new Error('Could not verify the previous terminal. Try again.')
      if (!current()) return
      retainExitedSession(entry, inventory.panes.some(pane => pane.tmuxPane === entry.tmuxPane))
    },
    waitForReady: saved => waitForResume(saved, current),
    canLaunch: async saved => {
      await stopJobs.get(agentId)
      return !registry.bySession(saved.sessionId) && (await checkPidRuntime(saved)).state === 'gone'
    },
    launch: async (saved, resumeSessionId) => {
      if (!tmuxBackend) return { ok: false, error: 'TMUX_UNAVAILABLE' }
      if (saved.grid && !saved.gridLaunch) return { ok: false, error: 'GRID_CREDENTIAL_REQUIRED', detail: 'The saved provider configuration is unavailable.' }
      if (saved.dsh && !installedDsh(saved.dsh)) return { ok: false, error: 'INVALID_DSH', detail: 'Install this harness from the Harness Store before resuming it.' }
      if (!saved.cwd) return { ok: false, error: 'CWD_NOT_FOUND', detail: 'The saved project folder is no longer available.' }
      const missing = workspaceMissing(saved.cwd)
      if (missing) return missing
      if (resumeSessionId && (!saved.transcriptPath || !validTranscriptPath(saved.engine, saved.transcriptPath, saved.codexHome ?? undefined))) {
        return { ok: false, error: 'RESUME_UNAVAILABLE', detail: 'The saved conversation file is unavailable. Start a new conversation separately.' }
      }
      // Match the registry's globally unique conversation index, including aliases/profiles.
      const key = saved.sessionId || saved.agentId
      if (resumeConversations.has(key)) return { ok: false, error: 'AGENT_BUSY' }
      resumeConversations.add(key)
      let token: string | null = null
      let allocationAttempted = false
      try {
        // Reserve before preparing history or rewriting launch configuration: an unknown previous
        // allocation may still have a writer using those files.
        token = stoppedAgents.beginResume(agentId)
        if (!token) return resumeUnconfirmed
        const built = await relaunchOverrides(saved)
        if (!built.ok) return { ok: false, error: built.error, detail: built.detail }
        if (!current()) return resumeChanged
        if (resumeSessionId) {
          try { prepareSessionResume(saved) } catch {
            return { ok: false, error: 'RESUME_PREPARATION_FAILED', detail: 'Could not prepare the saved conversation. Its history has been retained.' }
          }
        }
        if (saved.sessionId && registry.bySession(saved.sessionId)) return { ok: false, error: 'AGENT_BUSY' }
        const { env: launchEnv, extraArgs, clearEnv } = built.overrides
        const options = {
          resumeSessionId,
          bypassPermission: saved.bypassPermission === true,
          ...(saved.permissionMode ? { permissionMode: saved.permissionMode } : {}),
          cwd: saved.cwd,
          ...(extraArgs.length ? { extraArgs } : {}),
          ...(clearEnv.length ? { clearEnv } : {}),
          ...(launchEnv.HARNESS_DSH ? { harnessNode: true } : {}),
          installIfMissing: enginePathOverride(saved.engine) ? undefined : engineInstallRecipe(saved.engine),
        }
        clearDeleted(agentId)
        if (saved.sessionId) clearDeleted(saved.sessionId)
        allocationAttempted = true
        const result = await createAndRegisterPane({
          tmuxBackend,
          registry: { openPendingAgent: input => current() ? registry.resumePendingAgent(saved, input.runtimes) : null },
          maxAttempts: 1,
          engine: saved.engine,
          sessionLabel: buildHarnessSessionLabel(saved.engine),
          argv: buildEngineLaunchArgv(saved.engine, options),
          ...(Object.keys(launchEnv).length ? { env: launchEnv } : {}),
        })
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
          const killed = await tmuxBackend.kill(spawned.runtime)
          if (killed.state === 'succeeded') {
            retainExitedSession(pending, false)
            stoppedAgents.finishResume(agentId, token)
          }
          return resumeChanged
        }
        refreshGridWebSearch(pending.agentId, built.overrides)
        announceSession(pending)
        if (isTerminalEngine(saved.engine)) {
          await clearPaneRemainOnExit(spawned.runtime.paneId)
          if (!current()) return resumeChanged
          const ready = registry.setLaunch(pending.agentId, { state: 'ready' })!
          stoppedAgents.finishResume(agentId, token)
          announceSession(ready)
          return { ok: true, session: ready, resumed: true }
        }
        if (pending.dsh) attachDsh(pending)
        return await waitForResume(pending, current)
      } finally {
        if (token && !allocationAttempted) stoppedAgents.finishResume(agentId, token)
        resumeConversations.delete(key)
      }
    },
  })

  return (agentId: string) => restartJobs.run(agentId, async current => {
    await stopJobs.get(agentId)
    if (!current()) return resumeChanged
    if (pinnedControls.has(agentId)) return { ok: false, error: 'AGENT_BUSY' }
    return resumeStopped(agentId, current)
  }, 'resume')

}
