/**
 * Forking an agent (`agent_fork`): open a NEW pane whose engine starts with everything the source's
 * session has — `claude --resume <id> --fork-session`, `codex fork <id>` — or, for an engine that cannot
 * fork but takes a first prompt, a handoff message composed from what this daemon remembers of the
 * source (lib/forkAgent.ts). Same folder, same harness, same permission mode, same named agent; a grid
 * agent is refused rather than half-copied. The source is not touched — it is not even paused — which is
 * why it has to be IDLE: a fork taken mid-turn is a transcript cut in half.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import { statSync } from 'node:fs'
import type { BackendSocket } from '../../backendSocket.js'
import { installedDsh } from '../../dsh/installed.js'
import { harnessEnvToClear } from '../../dsh/launch.js'
import type { DshThrough } from './dshThrough.js'
import * as opencodeLaunch from '../../engines/launchControl.js'
import type { TurnRecaps } from '../turns/recaps.js'
import { createAndRegisterPane } from '../../lib/createAgentPane.js'
import { enginePathOverride } from '../../lib/engineBin.js'
import { engineInstallRecipe } from '../../lib/engineInstall.js'
import { buildEngineCommandArgv, buildEngineLaunchArgv, engineLaunchEnv, namedAgentArgs, refusePermissionFlagIfUnsupported, supportsNamedAgent } from '../../lib/engineLaunch.js'
import { forkName, planFork } from '../../lib/forkAgent.js'
import { buildHarnessSessionLabel } from '../../lib/harnessSessionLabel.js'
import { projectDisplayName, type registry, type RegisteredSession } from '../../lib/registry.js'
import type { TerminalBackend } from '../../lib/terminalBackend.js'
import { windowsLaunchRefusal } from '../../lib/windows/launch.js'
import { isWindowsHeldPane, windowsPaneLaunch } from '../../lib/windows/engineStart.js'
import { prepareInstructionWrites, scmLaunchEnv } from '../../scm/scmProjects.js'
import type { createLaunchHelpers } from './launch.js'
import { mergedLaunchEnv } from './launchEnv.js'
import type { createPaneWatcher } from './newPane.js'
import type { NativeLaunchResult, NativeLaunchSource } from '../../engines/nativeLaunch.js'
import type { LaunchAuthority, LaunchPreparation } from '../../lib/launchPreparation.js'
import type { LaunchOverridesDeps } from '../../lib/launchOverrides.js'
import type { AgentEngine } from '../../engines/types.js'
import { nativeHookLocations } from '../../engines/kit/nativeLocations.js'
import { GUEST_HARNESS_REFUSAL } from '../guestPolicy.js'

type ForkAgent = NonNullable<BackendSocket['onForkAgent']>

export interface ForkAgentDeps {
  native?: (engine: AgentEngine, source: NativeLaunchSource, authority: LaunchAuthority) => Promise<NativeLaunchResult>
  prepareNative?: LaunchOverridesDeps['prepareNative']
  authority?: (agentId: string) => () => boolean
  /** The backend new panes are made on, tmux or the pty host; null when none could be readied. */
  createBackend: TerminalBackend | null
  /** What a launch answers when [createBackend] is null: the configured backend's own code (terminalBackend.ts
   *  `noBackendCode`); `TMUX_UNAVAILABLE`, as before, by default. */
  noBackendCode?: string
  registry: typeof registry
  mirror: Pick<TurnRecaps, 'isBusy' | 'recentAsks' | 'recent' | 'lastFullText'>
  /** Forks whose session has not reported in yet, to the source session whose recap they inherit (bind.ts). */
  pendingForkInherit: Map<string, string>
  watchNewPane: ReturnType<typeof createPaneWatcher>
  announceSession: (session: RegisteredSession) => void
  attachDsh: (session: RegisteredSession) => void
  prepareApiTools: (cwd: string | null | undefined, engine: string) => void
  /** What a restart or a resume relaunches the row with (launch.ts): its own login, model and profile. */
  relaunchOverrides: ReturnType<typeof createLaunchHelpers>['relaunchOverrides']
  /** This account's private grid, as the socket knows it (BackendSocket.gridName). */
  gridName: () => string | null
  dshLaunch: Pick<DshThrough, 'launch'>
}

export function createAgentForker({
  native: inspectNative, prepareNative, authority: captureAuthority,
  createBackend, noBackendCode = 'TMUX_UNAVAILABLE', registry, mirror, pendingForkInherit, watchNewPane, announceSession, attachDsh, prepareApiTools, relaunchOverrides, gridName, dshLaunch,
}: ForkAgentDeps) {
  const prepare = async ({ agentId, name, prompt }: Parameters<ForkAgent>[0], authority: LaunchAuthority): Promise<LaunchPreparation<Awaited<ReturnType<ForkAgent>>>> => {
    const ownsSource = captureAuthority?.(agentId) ?? (() => true)
    const owner = () => authority.current() && ownsSource()
    const changed = { ok: false, error: 'AGENT_CHANGED', detail: 'The original fork source changed or stopped during preparation.' } as const
    if (!owner()) return changed
    if (!createBackend) return { ok: false, error: noBackendCode }
    const observed = registry.byAgent(agentId)
    if (!observed) return { ok: false, error: 'AGENT_NOT_FOUND' }
    if (observed.guest) return GUEST_HARNESS_REFUSAL
    const source = structuredClone(observed)
    const sourceName = projectDisplayName(source)
    if (!source.cwd) return { ok: false, error: 'CWD_NOT_FOUND', detail: `${sourceName} has no working folder on record.` }
    try {
      if (!statSync(source.cwd).isDirectory()) return { ok: false, error: 'CWD_NOT_FOUND' }
    } catch {
      return { ok: false, error: 'CWD_NOT_FOUND' }
    }
    if (source.gridLaunch || source.grid) {
      return { ok: false, error: 'FORK_ON_GRID_UNSUPPORTED', detail: `${sourceName} runs on a grid; forking a grid agent is not supported.` }
    }
    if (source.sessionId && mirror.isBusy(source.sessionId)) {
      return { ok: false, error: 'AGENT_BUSY', detail: `${sourceName} is in the middle of a turn. Wait for it to finish, then fork.` }
    }
    const engine = source.engine
    const memory = {
      asks: source.sessionId ? mirror.recentAsks(source.sessionId) : [],
      recaps: source.sessionId ? mirror.recent(source.sessionId, 5).map((t) => t.recap || t.text) : [],
      lastAnswer: source.sessionId ? mirror.lastFullText(source.sessionId) : undefined,
    }
    const plan = planFork({ engine, sessionId: source.sessionId, name: sourceName, cwd: source.cwd }, memory, prompt)
    if (!plan.ok) return { ok: false, error: plan.error, detail: plan.detail }
    const opencode = engine === 'opencode' ? opencodeLaunch : null

    const label = authority.label
    const inspected = await inspectNative?.(engine, source, { ...authority, current: owner })
    if (!owner()) return changed
    if (inspected && !inspected.ok) return inspected
    const native = inspected?.ok ? inspected.launch : undefined
    const current = () => owner() && native?.current() !== false
    // Fork the source's saved harness context. Workspace templates and init are not run again.
    let dshEnv: Record<string, string> | undefined
    let dshArgs: string[] = []
    let dshLabel: string | undefined
    if (source.dsh) {
      const installed = installedDsh(source.dsh)
      if (!installed) return { ok: false, error: 'INVALID_DSH', detail: `${source.dsh} is no longer installed on this machine` }
      // Narrowed above; a closure would lose that, so the checked values are named here.
      const cwd = source.cwd
      const prepared = await dshLaunch.launch({ dsh: source.dsh, workspace: cwd, engine, key: label,
        account: { privateGrid: gridName() }, forkOf: { agentId: source.agentId, dshRuntime: source.dshRuntime ?? null } })
      if (!current()) return changed
      if (!prepared.ok) return { ok: false, error: prepared.error, detail: prepared.detail,
        ...(prepared.unavailable ? { unavailable: prepared.unavailable } : {}) }
      dshEnv = prepared.launch.env
      dshArgs = prepared.launch.args
      dshLabel = installed.manifest.name
    }
    // The row's own login, model and profile, as a restart and a resume relaunch it (launch.ts): a Codex
    // agent moved back off a grid names its provider again (`-c model_provider=…`, `ownProvider` in
    // engines/codex/launch.ts) and the model it had before the grid (`-m`), and a profile gets
    // its hooks. A fork was launched without any of them, and came back on Codex's default model where a
    // restart of its source came back on the source's own (e2e/forks.e2e.ts). The harness and the named
    // agent are the fork's own (a new runtime, above and below), so they are not rebuilt here. A fork is started by
    // whoever forks it, not by the agent that started its source: its pull requests carry no line for that.
    const built = await relaunchOverrides(source, { ...source, dsh: null, agent: null, startedBy: null }, owner, native, label)
    if (!current()) return changed
    if (!built.ok) return built
    if (built.overrides.native && prepareNative && !await prepareNative(built.overrides.native, owner,
      { ...built.overrides.env, ...dshEnv }, [...built.overrides.clearEnv, ...harnessEnvToClear(dshEnv)])) {
      return { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Waiting to confirm the fork’s final native configuration.' }
    }
    if (!current()) return changed
    const dispatchCurrent = () => current() && built.overrides.native?.current() !== false
    const installIfMissing = enginePathOverride(engine) ? undefined : engineInstallRecipe(engine)
    // Same guard as a relaunch (`buildLaunchOverrides`): an opencode agent recorded on v1 forks on v2
    // as a general session rather than handing the v2 TUI an `--agent` it exits on.
    const forkMajor = built.overrides.native ? built.overrides.native.opencodeMajor : opencode ? await opencode.opencodeMajorVersion() : null
    const extraArgs = [...built.overrides.extraArgs, ...dshArgs, ...(source.agent && supportsNamedAgent(engine, forkMajor) ? namedAgentArgs(engine, source.agent, forkMajor) : [])]
    const firstPrompt = plan.level === 'native' ? (prompt ?? undefined) : plan.firstPrompt
    const launchOptions = {
      ...(built.overrides.native ? { native: built.overrides.native } : {}),
      clearEnv: harnessEnvToClear(dshEnv),
      bypassPermission: source.bypassPermission ?? false,
      ...(source.permissionMode ? { permissionMode: source.permissionMode } : {}),
      extraArgs: extraArgs.length ? extraArgs : undefined,
      installIfMissing,
      cwd: source.cwd,
      harnessNode: source.dsh ? true : undefined,
      ...(plan.level === 'native' ? { forkSessionId: plan.forkSessionId } : {}),
      ...(firstPrompt ? { firstPrompt } : {}),
    }
    // Same refusal as create: the clone inherits the source's permission mode, and an engine that
    // has since been downgraded would hand back a pane of help text instead of a harness.
    const forkRefusal = await refusePermissionFlagIfUnsupported(engine, launchOptions, undefined, built.overrides.native)
    if (!dispatchCurrent()) return changed
    if (forkRefusal) {
      console.warn(`[agent] fork refused · ${engine} · ${forkRefusal.detail}`)
      return { ok: false, ...forkRefusal }
    }
    await prepareInstructionWrites(source.cwd)
    if (!dispatchCurrent()) return changed
    prepareApiTools(source.cwd, engine)
    // Windows refuses a batch-file engine whose arguments cmd.exe would read (lib/windows/launch.ts), before any pane.
    let command: string[], argv: string[]
    try {
      command = buildEngineCommandArgv(engine, launchOptions)
      argv = buildEngineLaunchArgv(engine, launchOptions)
    } catch (error) { return windowsLaunchRefusal(error) }
    return { ok: true, dispatch: async () => {
    if (!dispatchCurrent()) return changed
    const result = await createAndRegisterPane({
      current: dispatchCurrent, ...(built.overrides.native ? { nativeToken: built.overrides.native.token } : {}),
      tmuxBackend: createBackend,
      registry,
      engine,
      cwd: source.cwd,
      sessionLabel: label,
      argv,
      // Windows: the workspace to start in and the shell the pane becomes after the engine (lib/windows/engineStart.ts).
      paneLaunch: windowsPaneLaunch(engine, { ...launchOptions, held: isWindowsHeldPane(argv) }),
      // The SCM's environment last, after the harness context's, as at create and relaunch.
      // Windows: the variables the argv's `/usr/bin/env` prefix carries elsewhere, last (engineLaunchEnv).
      env: mergedLaunchEnv(mergedLaunchEnv(mergedLaunchEnv(Object.keys(built.overrides.env).length ? built.overrides.env : undefined, dshEnv),
        mergedLaunchEnv(scmLaunchEnv(source.scmLaunch), built.overrides.native?.environment)), engineLaunchEnv(engine, built.overrides.native)),
      grid: null,
      gridLaunchRecord: null,
      // Same folder as the source, so the same workspace binding.
      scmLaunchRecord: source.scmLaunch ?? null,
      codexHome: engine === 'codex' && built.overrides.native
        ? nativeHookLocations(built.overrides.native.environment).CODEX_HOME : source.codexHome ?? null,
      dshRuntime: source.dsh ? label : null,
      dsh: source.dsh ?? null,
      agent: source.agent ?? null,
      bypassPermission: source.bypassPermission ?? false,
      permissionMode: source.permissionMode ?? null,
      defaultName: name ?? forkName(sourceName),
      label: dshLabel,
      // The session being forked from, so a Change agent right after the fork reads exactly that conversation.
      forkedFrom: {
        agentId: source.agentId, name: sourceName,
        ...(source.sessionId ? { sessionId: source.sessionId, ...(source.transcriptPath ? { transcriptPath: source.transcriptPath } : {}) } : {}),
      },
    })
    if (!result.ok) return { ok: false, error: result.error, detail: result.detail }
    const { spawned, pending } = result
    // The new tile starts with the source's last recap on it, the way a native fork's pane starts with
    // the source's transcript: memory in both places, not one. Settled when the engine names its session.
    if (source.sessionId) pendingForkInherit.set(pending.agentId, source.sessionId)
    announceSession(pending)
    if (pending.dsh) attachDsh(pending)
    void watchNewPane(engine, pending, spawned, command, installIfMissing)
    console.log(`[agent] fork pane open · ${engine} · ${plan.level} · ${source.agentId} → ${pending.agentId}`)
    return { ok: true, session: pending, level: plan.level }
    } }
  }
  const forkAgent: ForkAgent = async input => {
    const label = buildHarnessSessionLabel(registry.byAgent(input.agentId)?.engine ?? 'terminal')
    const prepared = await prepare(input, { id: label, label, current: () => true, hold: () => {} })
    return prepared.ok ? prepared.dispatch() : prepared
  }
  return Object.assign(forkAgent, { prepare })
}
