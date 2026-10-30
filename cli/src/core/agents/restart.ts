/**
 * Restarting an agent in its own pane (`agent_restart`): same agentId, same session, same launch.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import type { AdoptSwarmSkill } from '../api.js'
import { homedir } from 'node:os'
import { isTerminalEngine, type AgentEngine } from '../../engines/types.js'
import { engineBin, enginePathOverride } from '../../lib/engineBin.js'
import { engineInstallRecipe } from '../../lib/engineInstall.js'
import { buildEngineLaunchArgv, commandAvailableInInteractiveShell } from '../../lib/engineLaunch.js'
import { windowsPaneLaunch } from '../../lib/windows/engineStart.js'
import { probeGatewayRuntime } from '../../lib/gatewayRuntime.js'
import { sid } from '../../lib/log.js'
import type { ProcessIdentity, registry, RegisteredSession } from '../../lib/registry.js'
import { bypassPermissionFor, restartAgent } from '../../lib/restartAgent.js'
import type { TerminalAgentReconciler } from '../../lib/terminalAgentReconciler.js'
import { restartTargetOf, type RestartTarget } from '../../lib/terminalBackend.js'
import type { TerminalBackendCoordinator } from '../../lib/terminalBackendCoordinator.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import type { HeldRestart } from './heldLaunches.js'
import { workspaceMissing } from '../../lib/workspaceCheck.js'
import type { createLaunchHelpers } from './launch.js'
import type { RestartAgent } from './launches.js'
import type { PaneSwap } from './swap.js'
import { moveHeldLine } from '../../lib/hostMove/moveAgent.js'
import type { LaunchOverridesDeps } from '../../lib/launchOverrides.js'
import { GUEST_HARNESS_REFUSAL } from '../guestPolicy.js'

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

export interface RelaunchCommitDeps {
  registry: Pick<typeof registry, 'updateProcessIdentity' | 'setActive' | 'byAgent'>
  announceSession: (session: RegisteredSession) => void
  refreshGridAssignment: (session: RegisteredSession) => void
}

/**
 * The row learns the engine a restart relaunched in [place] (restart, and a move's fallback to the old pane:
 * core/agents/hostMove.ts): its process and gateway, active again, the pane handed back to its backend's default
 * disposal, then announced. Gateway is a core process fact; optional grid metadata follows the committed binding in the
 * background, so an unavailable models service cannot hold this route. 'changed' when [current] went false before the
 * row learned the engine, 'changed after commit' once it had, 'vanished' when the row is gone.
 */
export async function commitRelaunchedEngine(
  deps: RelaunchCommitDeps, agentId: string, identity: ProcessIdentity, place: RestartTarget, current: () => boolean,
): Promise<RegisteredSession | 'changed' | 'changed after commit' | 'vanished'> {
  const gateway = await probeGatewayRuntime(identity)
  if (!current()) return 'changed'
  deps.registry.updateProcessIdentity(agentId, identity, gateway.kind)
  deps.registry.setActive(agentId, true)
  await place.backend.releaseHold(place.runtime)
  // The row has its new engine: cancelled from here on, the engine is still relaunched.
  if (!current()) return 'changed after commit'
  const refreshed = deps.registry.byAgent(agentId)
  if (!refreshed) return 'vanished'
  deps.announceSession(refreshed)
  deps.refreshGridAssignment(refreshed)
  return refreshed
}

export interface RestartDeps {
  adoptSwarmSkill?: AdoptSwarmSkill
  native?: LaunchOverridesDeps['native']
  restartJobs: PaneSwap['restartJobs']
  registry: typeof registry
  /** Whether a purge holds this agent (PurgeAgentService.busy). */
  purgeBusy: (agentId: string) => boolean | undefined
  /** Stops in flight, by agent (the stop service's own map). */
  stopJobs: Map<string, Promise<void>>
  /** Panes held for a multi-step answer (terminal control). */
  pinnedControls: Set<string>
  /** Each runtime's own backend: a row restarts on the one its pane is in (`restartTargetOf`). */
  terminals: Pick<TerminalBackendCoordinator, 'backendFor'>
  sameRestartTarget: PaneSwap['sameRestartTarget']
  agentReconciler: Pick<TerminalAgentReconciler, 'holdRoute' | 'releaseRoute'>
  terminalHintMachineName: () => string
  announceSession: (session: RegisteredSession) => void
  refreshGridAssignment: (session: RegisteredSession) => void
  relaunchOverrides: LaunchHelpers['relaunchOverrides']
  downgradedPermission: LaunchHelpers['downgradedPermission']
  refreshGridWebSearch: LaunchHelpers['refreshGridWebSearch']
  liveBypassPermission: PaneSwap['liveBypassPermission']
  paneSwapDeps: PaneSwap['paneSwapDeps']
  /** A held agent runs no engine to swap: its restart is its launch, now (core/agents/heldLaunches.ts). Null for
   *  any other agent. */
  restartHeld: (agentId: string) => Promise<HeldRestart> | null
  /** An agent a move a dead daemon left may still run beside (main.ts `moveHeld`): no engine of it starts this start. */
  moveHeld?: (agentId: string) => boolean
}

export function createAgentRestarter({
  native: inspectNative, adoptSwarmSkill,
  restartJobs, registry, purgeBusy, stopJobs, pinnedControls, terminals, sameRestartTarget, agentReconciler,
  terminalHintMachineName, announceSession, refreshGridAssignment, relaunchOverrides, downgradedPermission, refreshGridWebSearch,
  liveBypassPermission, paneSwapDeps, restartHeld, moveHeld,
}: RestartDeps) {
  /**
   * Web or device restarted an agent (`agent_restart`): exit the live engine process and relaunch it in
   * the SAME pane, keeping the SAME agentId/session — restart must never look like delete+create to
   * the registry or the UI. Two things guard that identity:
   *
   *  - `remain-on-exit` is re-armed on the pane before the old process is killed (mirrors what
   *    `create()` does at spawn time), or tmux would tear the pane — and with it the whole one-pane
   *    session — down the instant that process exits. The pty host's `holdOpen` is the same keep.
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
    // A pane a stopped move left may still run this conversation's engine: neither a swap nor a held launch starts
    // another beside it (core/main.ts, `removeOrphanMovePanes`).
    const heldId = registry.resolve(agentId)?.agentId ?? agentId
    if (moveHeld?.(heldId)) {
      console.warn(moveHeldLine(heldId))
      return { ok: false, error: 'AGENT_BUSY', detail: 'This harness is held until the daemon restarts.' }
    }
    let session = registry.resolve(agentId)
    if (!session) return { ok: false, error: 'AGENT_NOT_FOUND' }
    if (session.guest) return GUEST_HARNESS_REFUSAL
    if (!session.sessionId && (session.launch?.state === 'held' || session.launch?.state === 'starting') && session.launch.nativeToken) {
      return { ok: false, error: 'NATIVE_LAUNCH_HELD', detail: 'The original launch is held for recovery. Its first prompt or fork cannot be replaced by a fresh launch.' }
    }
    const held = restartHeld(session.agentId)
    if (held) return held
    // Restart respawns in place: a row with no runtime on a backend that can (holdOpen and respawn) cannot be
    // restarted here. Its tmux runtime first, never the bare `tmuxPane` (a ptyhost pane's id, on a ptyhost row).
    const place = restartTargetOf(session, (candidate) => terminals.backendFor(candidate))
    if (!place) return { ok: false, error: 'RESTART_UNSUPPORTED_BACKEND' }
    const { backend, runtime } = place
    const target = { ...session }
    const current = () => operationCurrent() && sameRestartTarget(target)
    const changed = { ok: false, error: 'AGENT_CHANGED', detail: 'The harness changed or stopped during restart.' } as const
    if (!current()) return changed
    // Both branches below `cd` into the row's folder before they exec, and both have already killed
    // (or respawned over) the old process by the time that `cd` fails. Ask first, over a live agent.
    const missing = workspaceMissing(session.cwd)
    if (missing) return missing
    const engine = session.engine
    const routeKey = terminalRouteKey(runtime)
    // Restarting a terminal is a fresh shell in the same pane — `respawn-pane -k` over whatever the
    // old one was doing. There is no engine to wait for and no session to resume, so none of the
    // process-swap choreography below applies. A terminal that ADOPTED an engine restarts the
    // engine, like any agent: the tile said Restart about the engine it shows.
    if (isTerminalEngine(engine)) {
      const releaseRoute = agentReconciler.holdRoute(routeKey, null)
      try {
        // The same opening a fresh terminal tile prints (`onCreateAgent`'s `terminalHint`): a
        // restarted tile is a fresh shell too, and should look like one.
        const command = buildEngineLaunchArgv(engine, {
          ...(session.cwd ? { cwd: session.cwd } : {}),
          terminalHint: { machineName: terminalHintMachineName() },
        })
        // Windows: the shell starts in the folder itself, which the launch enters elsewhere (lib/windows/engineStart.ts).
        const respawned = await backend.respawn(runtime, { command, cwd: homedir(), ...windowsPaneLaunch(engine, { cwd: session.cwd }) })
        if (!current()) return changed
        if (respawned.state !== 'succeeded') return { ok: false, error: 'RESTART_FAILED', detail: respawned.reason }
        await backend.releaseHold(runtime)
        if (!current()) return changed
        registry.setActive(session.agentId, true)
        const refreshed = registry.byAgent(session.agentId)
        if (!refreshed) return { ok: false, error: 'RESTART_FAILED', detail: 'agent vanished from the registry mid-restart' }
        announceSession(refreshed)
        console.log(`[restart] ${sid(session.agentId)} terminal · fresh shell`)
        return { ok: true, session: refreshed, resumed: false }
      } finally {
        releaseRoute()
      }
    }
    if (!session.processIdentity) return { ok: false, error: 'NO_ACTIVE_PROCESS' }

    // Fill a missing Swarm role before native inspection and launch preparation.
    if (adoptSwarmSkill) {
      const adopted = await adoptSwarmSkill(session, current)
      if (!adopted || !current()) return changed
      session = adopted
    }
    // The relaunch runs the engine's command again, so an engine uninstalled since the agent started
    // cannot come back. Asked anyway, the swap killed the working agent and gave up twenty seconds
    // later with "did not come back up" (updates.e2e.ts, round 24). Asked here, before anything is
    // touched, the agent goes on running and the person is told why.
    const inspected = await inspectNative?.(engine, session, { id: session.agentId, current })
    if (!current()) return changed
    if (inspected && !inspected.ok) return inspected
    const native = inspected?.ok ? inspected.launch : undefined
    const installed = native ? true : await engineInstalled(engine)
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
    const built = await relaunchOverrides(session, session, current, native)
    if (!current()) return changed
    if (!built.ok) return built

    // Shell startup and native checks can outlast the reconciler's default 30-second hold.
    // Keep this route through publication, and release only this operation's own reservation.
    const releaseRoute = agentReconciler.holdRoute(routeKey, null)
    try {
      const restartPermission = await downgradedPermission(session,
        await bypassPermissionFor(session, () => liveBypassPermission(session)), 'restart', built.overrides.native)
      if (restartPermission.nativeHold || built.overrides.native?.current() === false) return { ok: false, error: 'NATIVE_LAUNCH_HELD', detail: restartPermission.nativeHold ?? 'Waiting for fresh executable and hook evidence.' }
      const dispatchCurrent = () => current() && built.overrides.native?.current() !== false
      const outcome = await restartAgent(
        { engine, sessionId: session.sessionId, ...(session.resumeOnly ? { resumeOnly: true as const } : {}) },
        restartPermission.bypassPermission === true,
        { ...paneSwapDeps(session, place, built.overrides, restartPermission.permissionMode ?? null, dispatchCurrent), isCurrent: dispatchCurrent },
      )

      if (!current()) return changed
      // A refused relaunch (Windows: a batch-file engine cmd.exe would misread) stopped nothing: its own code.
      if (!outcome.ok) return { ok: false, error: outcome.error ?? 'RESTART_FAILED', detail: outcome.detail }
      refreshGridWebSearch(session.agentId, built.overrides)

      // Address the CANONICAL agentId from the resolved session, not the raw RPC input — `resolve()`
      // accepts either an agentId or a bare sessionId, but `setActive`/`byAgent` only ever key on the
      // real agentId.
      const refreshed = await commitRelaunchedEngine({ registry, announceSession, refreshGridAssignment }, session.agentId, outcome.processIdentity, place, current)
      if (refreshed === 'changed' || refreshed === 'changed after commit') return changed
      if (refreshed === 'vanished') return { ok: false, error: 'RESTART_FAILED', detail: 'agent vanished from the registry mid-restart' }
      console.log(`[restart] ${sid(session.agentId)} ${engine} · ${outcome.resumed ? 'resumed' : 'fresh session'}`
        + (session.gridLaunch ? ` · grid ${session.gridLaunch.networkName}` : ''))
      return { ok: true, session: refreshed, resumed: outcome.resumed }
    } finally {
      releaseRoute()
    }
  })
  return restartAgentHandler
}
