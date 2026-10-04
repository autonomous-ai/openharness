/**
 * The pane-process swap: kill an agent's engine, respawn it in the pane it was already in, and wait for
 * the new process — what restart and retarget both do, with the restart coordinator that keeps one swap
 * per agent at a time, and the bypass flag the live process was launched with.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import { homedir } from 'node:os'
import { checkPidRuntime, terminateDeletedAgent } from '../../lib/deleteAgentFallback.js'
import { buildEngineLaunchArgv } from '../../lib/engineLaunch.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { AgentRestartCoordinator, type RestartAgentDeps } from '../../lib/restartAgent.js'
import { processRows } from '../../lib/terminalAgentDiscovery.js'
import type { TmuxRuntimeRef } from '../../lib/terminalTypes.js'
import { bypassPermissionActive, resolvePaneEngineProcess } from '../../lib/tmux.js'
import type { TmuxBackend } from '../../lib/tmuxBackend.js'

export interface PaneSwapDeps {
  byAgent: (agentId: string) => RegisteredSession | undefined
  /** The tmux backend; a swap only ever runs where there is one. */
  tmuxBackend: TmuxBackend | null
  prepareSessionResume: (session: RegisteredSession) => void
}

export function createPaneSwap({ byAgent, tmuxBackend, prepareSessionResume }: PaneSwapDeps) {
  /**
   * The dependencies a pane-process swap needs, for both callers that do one.
   *
   * Restart and retarget are the same mechanism pointed at different ends: kill the engine, respawn it
   * in the pane it was already in, wait for the new process. They differ only in what the replacement
   * is launched WITH — retarget adds the grid's environment and the argv that configures it — so that
   * is the only thing this takes. Written once because two copies of a kill sequence drift, and the
   * half that drifts is the half nobody ran today.
   */
  const restartJobs = new AgentRestartCoordinator()
  const sameRestartTarget = (session: RegisteredSession): boolean => {
    const current = byAgent(session.agentId)
    return !!current && current.registeredAt === session.registeredAt
      && current.tmuxPane === session.tmuxPane && current.engine === session.engine
  }

  const paneSwapDeps = (
    session: RegisteredSession,
    runtime: TmuxRuntimeRef,
    launch: { env?: Record<string, string>; extraArgs?: readonly string[]; clearEnv?: readonly string[] } = {},
    /** The mode this swap may actually ask for — the row's own, unless the engine on disk has since
     *  stopped taking its flag and the caller dropped it (`dropPermissionFlagIfUnsupported`). */
    permissionMode: string | null = session.permissionMode ?? null,
  ): RestartAgentDeps => ({
    prepareResume: () => prepareSessionResume(session),
    holdOpen: async () => {
      const result = await tmuxBackend!.holdOpen(runtime)
      return result.state === 'succeeded'
        ? { ok: true }
        : { ok: false, reason: 'reason' in result ? result.reason : 'could not re-arm remain-on-exit' }
    },
    terminate: (checkAfterMs) => terminateDeletedAgent(session, {
      checkRuntime: checkPidRuntime,
      kill: (pid, signal) => process.kill(pid, signal),
      sleep: (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.() }),
      log: (message) => console.log(message),
    }, checkAfterMs),
    respawn: async (argv) => {
      const result = await tmuxBackend!.respawn(runtime, {
        command: argv,
        cwd: homedir(),
        ...(launch.env ? { env: launch.env } : {}),
      })
      return result.state === 'succeeded'
        ? { ok: true }
        : { ok: false, reason: 'reason' in result ? result.reason : 'tmux respawn-pane did not complete' }
    },
    waitForProcess: async () => {
      // Mirrors onCreateAgent's own discovery budget/backoff shape for the same reason: the engine's
      // interactive-login-shell startup, not the tmux call, is the slow half.
      const SWAP_DISCOVERY_BUDGET_MS = 8_000
      let delayMs = 150
      let waited = 0
      while (waited < SWAP_DISCOVERY_BUDGET_MS) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        waited += delayMs
        const found = await resolvePaneEngineProcess(runtime.paneId, session.engine)
        if (found) return found
        delayMs = Math.min(delayMs * 2, 750)
      }
      return null
    },
    buildArgv: (opts) => buildEngineLaunchArgv(session.engine, {
      ...opts,
      // The mode picked at create outranks what the live argv said: `bypassPermission` is a yes/no, and
      // Plan or Accept edits would come back as Ask without it.
      ...(permissionMode ? { permissionMode } : {}),
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(launch.extraArgs?.length ? { extraArgs: launch.extraArgs } : {}),
      // A pane swap onto a grid has to clear the same vendor credentials a fresh create does, for the
      // same reason and against the same failure: an engine re-exec'd with the grid's variables still
      // sees whatever else the pane inherited, and picks its provider from all of it. This was the
      // gap — a create cleared them, then moving that agent onto a grid from the pane header put them
      // straight back, so the engine came up on Anthropic with a grid selected above it.
      //
      // Named by the caller (`buildLaunchOverrides` derives it from what the grid launch provides), so
      // a swap that sets no grid — back to the engine's own login, or a Codex profile's CODEX_HOME —
      // clears nothing. There the user's own variables are the point.
      ...(launch.clearEnv?.length ? { clearEnv: launch.clearEnv } : {}),
      ...(launch.env?.HARNESS_DSH ? { harnessNode: true } : {}),
    }),
    log: (message) => console.log(message),
  })

  /** The bypass-permission flag the LIVE process was launched with. The fallback behind
   *  `bypassPermissionFor` for a row that recorded neither a mode nor the flag (written before either
   *  was persisted, and not yet seen by a discovery scan); read before anything is signalled. */
  const liveBypassPermission = async (session: RegisteredSession): Promise<boolean> => {
    const identity = session.processIdentity
    if (!identity) return false
    const rows = await processRows()
    const row = rows?.find((candidate) =>
      candidate.pid === identity.pid && candidate.startMarker === identity.startMarker)
    return row ? bypassPermissionActive(session.engine, row.args) : false
  }
  return { restartJobs, sameRestartTarget, paneSwapDeps, liveBypassPermission }
}

export type PaneSwap = ReturnType<typeof createPaneSwap>
