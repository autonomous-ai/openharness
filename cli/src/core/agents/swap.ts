/**
 * The pane-process swap: kill an agent's engine, respawn it in the pane it was already in, and wait for
 * the new process — what restart and retarget both do, with the restart coordinator that keeps one swap
 * per agent at a time, and the bypass flag the live process was launched with.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import { homedir } from 'node:os'
import { checkPidRuntime, terminateDeletedAgent } from '../../lib/deleteAgentFallback.js'
import { buildEngineCommandArgv, buildEngineLaunchArgv, engineLaunchEnv } from '../../lib/engineLaunch.js'
import { engineBin } from '../../lib/engineBin.js'
import { stopConflictingBackgroundJob } from '../../lib/claudeBackgroundJob.js'
import { windowsLaunchRefusal } from '../../lib/windows/launch.js'
import { isWindowsHeldPane, windowsPaneLaunch } from '../../lib/windows/engineStart.js'
import { mergedLaunchEnv } from './launchEnv.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { AgentRestartCoordinator, type RelaunchArgvOptions, type RestartAgentDeps } from '../../lib/restartAgent.js'
import { processRows } from '../../lib/terminalAgentDiscovery.js'
import type { RestartTarget } from '../../lib/terminalBackend.js'
import { resolvePaneEngineProcess } from '../../lib/paneEngineProcess.js'
import { bypassPermissionActive } from '../../lib/processTable.js'
import { sameProcessIdentity } from '../../lib/terminalRuntime.js'
import { signalAgentProcess } from '../../lib/processSignals.js'
import type { StopAgentServiceDeps } from '../../lib/stopAgentService.js'
import { paneReadIdentity } from '../transcripts/readIdentity.js'

export interface PaneSwapDeps {
  restartJobs?: AgentRestartCoordinator
  byAgent: (agentId: string) => RegisteredSession | undefined
  prepareSessionResume: (session: RegisteredSession) => void
  /** Keeps a conversation a swap had to leave for a new one as a stopped harness (lib/keepAbandonedConversation.ts). */
  keepAbandonedConversation: (left: RegisteredSession) => void
  /** Release the conversation on its engine's server before replacing the terminal client. */
  stopNative: StopAgentServiceDeps['stopNative']
}

/** How long a relaunched engine must stay running before a restart counts it as come up (`waitForProcess`). */
export const SWAP_SETTLE_MS = 500

export function createPaneSwap({ byAgent, prepareSessionResume, keepAbandonedConversation, stopNative, restartJobs = new AgentRestartCoordinator() }: PaneSwapDeps) {
  /**
   * The dependencies a pane-process swap needs, for both callers that do one.
   *
   * Restart and retarget are the same mechanism pointed at different ends: kill the engine, respawn it
   * in the pane it was already in, wait for the new process. They differ only in what the replacement
   * is launched WITH — retarget adds the grid's environment and the argv that configures it — so that
   * is the only thing this takes. Written once because two copies of a kill sequence drift, and the
   * half that drifts is the half nobody ran today.
   */
  const sameRestartTarget = (session: RegisteredSession): boolean => {
    const current = byAgent(session.agentId)
    return !!current && current.registeredAt === session.registeredAt
      && current.tmuxPane === session.tmuxPane && current.engine === session.engine
  }

  const paneSwapDeps = (
    session: RegisteredSession,
    /** The row's own pane and the backend it is on (`restartTargetOf`): a swap runs where the row is. */
    { backend, runtime }: RestartTarget,
    launch: { native?: import('../../engines/nativeLaunch.js').NativeLaunch; env?: Record<string, string>; extraArgs?: readonly string[]; clearEnv?: readonly string[]
      /** Names the respawn takes out of what the pane was created with, on a backend with no `clearEnv()` of its own
       *  (the pty host): a retarget home's grid variables. */
      clearPaneEnv?: readonly string[] } = {},
    /** The mode this swap may actually ask for — the row's own, unless the engine on disk has since
     *  stopped taking its flag and the caller dropped it (`dropPermissionFlagIfUnsupported`). */
    permissionMode: string | null = session.permissionMode ?? null,
    current?: () => boolean,
  ): RestartAgentDeps => {
    const target = { ...session, processIdentity: session.processIdentity && { ...session.processIdentity } }
    const identity = paneReadIdentity(target)
    const ownsOriginal = () => current?.() !== false && sameRestartTarget(target)
      && paneReadIdentity(byAgent(target.agentId)) === identity
    const relaunchOptions = (opts: RelaunchArgvOptions) => ({
      ...opts,
      ...(launch.native ? { native: launch.native } : {}),
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
    })
    return {
      ...(current ? { isCurrent: current } : {}),
      prepareResume: () => prepareSessionResume(session),
      // The row as the swap found it: the conversation a fallback to a fresh start leaves behind.
      keepAbandoned: () => keepAbandonedConversation(session),
      // Only a backend that can refuse is asked (tmux, too old for `-e`); the pty host takes any environment.
      ...(backend.respawnRefusal ? { respawnRefusal: () => backend.respawnRefusal!(launch.env ? { env: launch.env } : {}) } : {}),
      holdOpen: async () => {
        const result = await backend.holdOpen(runtime, current)
        return result.state === 'succeeded'
          ? { ok: true }
          : { ok: false, reason: 'reason' in result ? result.reason : 'could not re-arm remain-on-exit' }
      },
      terminate: async (checkAfterMs) => {
        if (!ownsOriginal()) return 'not-ours'
        // A failed native turn can leave the shared app-server holding its writer lock.
        // Release that conversation before stopping its terminal client.
        await stopNative(target, ownsOriginal)
        if (!ownsOriginal()) return 'not-ours'
        return terminateDeletedAgent(target, {
          checkRuntime: checkPidRuntime,
          kill: signalAgentProcess,
          sleep: (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.() }),
          log: (message) => console.log(message),
          current: ownsOriginal,
        }, checkAfterMs)
      },
      respawn: async (argv) => {
        // Windows: the variables the argv's `/usr/bin/env` prefix carries elsewhere, last (engineLaunchEnv).
        const env = mergedLaunchEnv(launch.env, engineLaunchEnv(session.engine, launch.native))
        const result = await backend.respawn(runtime, {
          command: argv,
          ...(current ? { current } : {}),
          cwd: homedir(),
          // Windows: the workspace to start in, what this launch alone must not inherit from the host (its own
          // `clearEnv`, a grid's keys: none for a swap that sets no grid), and the shell the pane becomes after the
          // engine (lib/windows/engineStart.ts). Never merged with `clearPaneEnv`, which only takes names out of
          // what the pane was created with, as tmux's `set-environment -u` does.
          ...windowsPaneLaunch(session.engine, { ...relaunchOptions({ bypassPermission: false }), held: isWindowsHeldPane(argv) }),
          ...(env ? { env } : {}),
          ...(launch.clearPaneEnv?.length ? { clearEnv: launch.clearPaneEnv } : {}),
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
          const found = await resolvePaneEngineProcess(backend, runtime, session.engine)
          if (found) {
            // Up means still up a moment later: a launch the engine refuses (`codex resume` after an update
            // dropped it) runs for an instant, and seen then, the restart said "resumed" and never fell back
            // to a fresh start (e2e/updates.e2e.ts on Linux, whose faster start put it in the first look).
            await new Promise((resolve) => setTimeout(resolve, SWAP_SETTLE_MS))
            waited += SWAP_SETTLE_MS
            const still = await resolvePaneEngineProcess(backend, runtime, session.engine)
            if (sameProcessIdentity(still, found)) return found
          }
          delayMs = Math.min(delayMs * 2, 750)
        }
        return null
      },
      buildArgv: (opts) => buildEngineLaunchArgv(session.engine, relaunchOptions(opts)),
      // The same command, built without its launch script (no file is written), before anything is stopped.
      launchRefusal: (opts) => {
        try { buildEngineCommandArgv(session.engine, relaunchOptions(opts)); return null } catch (error) { return windowsLaunchRefusal(error).detail }
      },
      // Claude only. `launch.native` is the captured launch for every ordinary LOCAL Claude run
      // (launchOverrides.ts), not a signal the pane is elsewhere, so it must not gate this off. A DSH
      // agent's pane is the one case that may run on a different host entirely, whose `claude --bg`
      // jobs this process cannot see.
      ...(session.engine === 'claude' && !session.dsh ? { stopConflictingJob: () =>
        // The exact environment the pane is about to get, the same way `respawn` above builds it: `launch.env`
        // already carries a native launch's own CLAUDE_CONFIG_DIR (launchOverrides.ts merges `native.environment`
        // into it), and `engineLaunchEnv` adds Windows's own-process variables.
        stopConflictingBackgroundJob({ bin: engineBin(session.engine), sessionId: session.sessionId,
          env: { ...process.env, ...launch.env, ...engineLaunchEnv(session.engine, launch.native) } }) } : {}),
      log: (message) => console.log(message),
    }
  }

  /** The bypass-permission flag the LIVE process was launched with. The fallback behind
   *  `bypassPermissionFor` for a row that recorded neither a mode nor the flag (written before either
   *  was persisted, and not yet seen by a discovery scan); read before anything is signalled. */
  const liveBypassPermission = async (session: RegisteredSession): Promise<boolean> => {
    const identity = session.processIdentity
    if (!identity) return false
    const rows = await processRows()
    const row = rows?.find((candidate) => sameProcessIdentity(candidate, identity))
    return row ? bypassPermissionActive(session.engine, row.args) : false
  }
  return { restartJobs, sameRestartTarget, paneSwapDeps, liveBypassPermission }
}

export type PaneSwap = ReturnType<typeof createPaneSwap>
