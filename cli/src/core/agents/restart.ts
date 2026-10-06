/**
 * Restarting an agent in its own pane (`agent_restart`): same agentId, same session, same launch.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import { homedir } from 'node:os'
import { isTerminalEngine, type AgentEngine } from '../../engines/types.js'
import { engineBin, enginePathOverride } from '../../lib/engineBin.js'
import { engineInstallRecipe } from '../../lib/engineInstall.js'
import { buildEngineLaunchArgv, commandAvailableInInteractiveShell } from '../../lib/engineLaunch.js'
import { probeGatewayRuntime } from '../../lib/gatewayRuntime.js'
import { probeGridAssignment } from '../../lib/gridAssignment.js'
import { sid } from '../../lib/log.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import { bypassPermissionFor, restartAgent } from '../../lib/restartAgent.js'
import type { TerminalAgentReconciler } from '../../lib/terminalAgentReconciler.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import type { TmuxRuntimeRef } from '../../lib/terminalTypes.js'
import { clearPaneRemainOnExit, processArgs } from '../../lib/tmux.js'
import type { TmuxBackend } from '../../lib/tmuxBackend.js'
import { workspaceMissing } from '../../lib/workspaceCheck.js'
import type { createLaunchHelpers } from './launch.js'
import type { RestartAgent } from './launches.js'
import type { PaneSwap } from './swap.js'

type LaunchHelpers = ReturnType<typeof createLaunchHelpers>

/**
 * Longer than any shell that answered: `commandAvailableInInteractiveShell` gives up after 5s and then
 * says no. A no that took that long is a slow rc file, not a missing engine, and must not refuse a
 * restart that would work — the same rule `commandSupportsFlagInInteractiveShell` keeps for `unknown`.
 */
const ENGINE_CHECK_GAVE_UP_MS = 4_500

/**
 * Whether the engine's command is on this machine, asked as create asks of a pane that died: the same
 * interactive shell, the same command, the same install recipe. Null when the shell gave up first.
 */
async function engineInstalled(engine: AgentEngine): Promise<boolean | null> {
  const startedAt = Date.now()
  const installed = await commandAvailableInInteractiveShell(engineBin(engine), undefined,
    enginePathOverride(engine) ? undefined : engineInstallRecipe(engine))
  return installed || Date.now() - startedAt < ENGINE_CHECK_GAVE_UP_MS ? installed : null
}

type RestartAgentHandler = RestartAgent

export interface RestartDeps {
  restartJobs: PaneSwap['restartJobs']
  registry: typeof registry
  /** Whether a purge holds this agent (PurgeAgentService.busy). */
  purgeBusy: (agentId: string) => boolean | undefined
  /** Stops in flight, by agent (the stop service's own map). */
  stopJobs: Map<string, Promise<void>>
  /** Panes held for a multi-step answer (terminal control). */
  pinnedControls: Set<string>
  tmuxBackend: TmuxBackend | null
  sameRestartTarget: PaneSwap['sameRestartTarget']
  agentReconciler: Pick<TerminalAgentReconciler, 'holdRoute' | 'releaseRoute'>
  terminalHintMachineName: () => string
  announceSession: (session: RegisteredSession) => void
  relaunchOverrides: LaunchHelpers['relaunchOverrides']
  downgradedPermission: LaunchHelpers['downgradedPermission']
  refreshGridWebSearch: LaunchHelpers['refreshGridWebSearch']
  liveBypassPermission: PaneSwap['liveBypassPermission']
  paneSwapDeps: PaneSwap['paneSwapDeps']
}

export function createAgentRestarter({
  restartJobs, registry, purgeBusy, stopJobs, pinnedControls, tmuxBackend, sameRestartTarget, agentReconciler,
  terminalHintMachineName, announceSession, relaunchOverrides, downgradedPermission, refreshGridWebSearch,
  liveBypassPermission, paneSwapDeps,
}: RestartDeps) {
  /**
   * Web or device restarted an agent (`agent_restart`): exit the live engine process and relaunch it in
   * the SAME tmux pane, keeping the SAME agentId/session — restart must never look like delete+create to
   * the registry or the UI. Two things guard that identity:
   *
   *  - `remain-on-exit` is re-armed on the pane before the old process is killed (mirrors what
   *    `create()` does at spawn time), or tmux would tear the pane — and with it the whole one-pane
   *    session — down the instant that process exits.
   *  - the periodic reconciler is told to ignore this pane's ROUTE for the duration of the swap
   *    (`agentReconciler.holdRoute`/`releaseRoute`), or it would either flicker the agent dormant
   *    mid-kill, or — worse — mint a brand-new agent for the relaunched process the instant it appears,
   *    before this handler gets to rebind it.
   *
   * The permission mode comes from the registry row (`bypassPermissionFor`): what create recorded, or
   * what discovery read off the live argv since — the live process is probed only for a row that has
   * neither, and before anything is signalled. The sessionId to resume comes from the registry's
   * live-synced field, not from the original launch argv (the user may have resumed/switched sessions
   * from inside the engine's own terminal since launch).
   */
  const restartAgentHandler: RestartAgentHandler = (agentId) => restartJobs.run(registry.resolve(agentId)?.agentId ?? agentId, async (operationCurrent) => {
    if (purgeBusy(agentId) || stopJobs.has(agentId) || pinnedControls.has(agentId)) return { ok: false, error: 'AGENT_BUSY' }
    const session = registry.resolve(agentId)
    if (!session) return { ok: false, error: 'AGENT_NOT_FOUND' }
    if (!session.tmuxPane || !tmuxBackend) return { ok: false, error: 'RESTART_UNSUPPORTED_BACKEND' }
    const target = { ...session }
    const current = () => operationCurrent() && sameRestartTarget(target)
    const changed = { ok: false, error: 'AGENT_CHANGED', detail: 'The harness changed or stopped during restart.' } as const
    if (!current()) return changed
    // Both branches below `cd` into the row's folder before they exec, and both have already killed
    // (or respawned over) the old process by the time that `cd` fails. Ask first, over a live agent.
    const missing = workspaceMissing(session.cwd)
    if (missing) return missing
    const pane = session.tmuxPane
    const engine = session.engine
    const runtime: TmuxRuntimeRef = { backend: 'tmux', paneId: pane }
    const routeKey = terminalRouteKey(runtime)
    // Restarting a terminal is a fresh shell in the same pane — `respawn-pane -k` over whatever the
    // old one was doing. There is no engine to wait for and no session to resume, so none of the
    // process-swap choreography below applies. A terminal that ADOPTED an engine restarts the
    // engine, like any agent: the tile said Restart about the engine it shows.
    if (isTerminalEngine(engine)) {
      agentReconciler.holdRoute(routeKey)
      try {
        // The same opening a fresh terminal tile prints (`onCreateAgent`'s `terminalHint`): a
        // restarted tile is a fresh shell too, and should look like one.
        const respawned = await tmuxBackend.respawn(runtime, {
          command: buildEngineLaunchArgv(engine, {
            ...(session.cwd ? { cwd: session.cwd } : {}),
            terminalHint: { machineName: terminalHintMachineName() },
          }),
          cwd: homedir(),
        })
        if (!current()) return changed
        if (respawned.state !== 'succeeded') return { ok: false, error: 'RESTART_FAILED', detail: respawned.reason }
        await clearPaneRemainOnExit(pane)
        if (!current()) return changed
        registry.setActive(session.agentId, true)
        const refreshed = registry.byAgent(session.agentId)
        if (!refreshed) return { ok: false, error: 'RESTART_FAILED', detail: 'agent vanished from the registry mid-restart' }
        announceSession(refreshed)
        console.log(`[restart] ${sid(session.agentId)} terminal · fresh shell`)
        return { ok: true, session: refreshed, resumed: false }
      } finally {
        agentReconciler.releaseRoute(routeKey)
      }
    }
    if (!session.processIdentity) return { ok: false, error: 'NO_ACTIVE_PROCESS' }

    // The relaunch runs the engine's command again, so an engine uninstalled since the agent started
    // cannot come back. Asked anyway, the swap killed the working agent and gave up twenty seconds
    // later with "did not come back up" (updates.e2e.ts, round 24). Asked here, before anything is
    // touched, the agent goes on running and the person is told why.
    const installed = await engineInstalled(engine)
    if (!current()) return changed
    if (installed === false) {
      console.warn(`[restart] ${sid(session.agentId)} refused · ${engine} is not installed`)
      return { ok: false, error: 'ENGINE_NOT_INSTALLED', detail: `${engine} is not installed. Install it, then restart again. Nothing was stopped.` }
    }

    // The replacement is launched WITH what the original was: its grid's env and argv (a bare
    // respawn would inherit the tmux session's variables but never the codex `-c …` / pi `--model`
    // half, and an agent moved here by a retarget has nothing in the session env at all), or its
    // Codex profile. Refused before anything is killed, so a restart that cannot honour the grid
    // leaves the running process alone.
    const built = await relaunchOverrides(session)
    if (!current()) return changed
    if (!built.ok) return { ok: false, error: built.error, detail: built.detail }

    agentReconciler.holdRoute(routeKey)
    try {
      const restartPermission = await downgradedPermission(session,
        await bypassPermissionFor(session, () => liveBypassPermission(session)), 'restart')
      const outcome = await restartAgent(
        { engine, sessionId: session.sessionId },
        restartPermission.bypassPermission === true,
        { ...paneSwapDeps(session, runtime, built.overrides, restartPermission.permissionMode ?? null), isCurrent: current },
      )

      if (!current()) return changed
      if (!outcome.ok) return { ok: false, error: 'RESTART_FAILED', detail: outcome.detail }
      refreshGridWebSearch(session.agentId, built.overrides)

      // Address the CANONICAL agentId from the resolved session, not the raw RPC input — `resolve()`
      // accepts either an agentId or a bare sessionId, but `setActive`/`byAgent` only ever key on the
      // real agentId. Gateway and grid are re-read off the new pid now (one cached env read) rather
      // than left to the next scan, so the announce below already says where the engine came back.
      const [gateway, assignment] = await Promise.all([
        probeGatewayRuntime(outcome.processIdentity),
        // Its command line, which carries a Codex or pi grid's address and model: never its executable.
        processArgs(outcome.processIdentity).then((args) => probeGridAssignment(outcome.processIdentity, engine, args)),
      ])
      if (!current()) return changed
      registry.updateProcessIdentity(session.agentId, outcome.processIdentity, gateway.kind, assignment)
      registry.setActive(session.agentId, true)
      await clearPaneRemainOnExit(pane)
      if (!current()) return changed
      const refreshed = registry.byAgent(session.agentId)
      if (!refreshed) return { ok: false, error: 'RESTART_FAILED', detail: 'agent vanished from the registry mid-restart' }
      announceSession(refreshed)
      console.log(`[restart] ${sid(session.agentId)} ${engine} · ${outcome.resumed ? 'resumed' : 'fresh session'}`
        + (session.gridLaunch ? ` · grid ${session.gridLaunch.networkName}` : ''))
      return { ok: true, session: refreshed, resumed: outcome.resumed }
    } finally {
      agentReconciler.releaseRoute(routeKey)
    }
  })
  return restartAgentHandler
}
