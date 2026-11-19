import type { NativeLaunch, NativeLaunchResult, NativeLaunchSource } from '../../engines/nativeLaunch.js'
/**
 * Creating an agent (`agent_create`): open a fresh pane running the chosen engine in the chosen
 * folder, as a domain-specific harness or a plain session, on a grid or the engine's own login, opening
 * a conversation Harness did not start when asked — and refuse, before any pane opens, every launch
 * that would not do what was asked. The pane is then watched until its engine is up.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BackendSocket } from '../../backendSocket.js'
import type { ConnectorsPort } from '../api.js'
import type { DshAccount } from '../../dsh/launch.js'
import { harnessEnvToClear } from '../../dsh/sessionEnv.js'
import type { DshThrough } from './dshThrough.js'
import { isTerminalEngine, type AgentEngine } from '../../engines/types.js'
import { OPENCLAW_LOCAL } from '../../engines/openclaw/contract.js'
import { engineLabel } from '../../lib/agentNames.js'
import { createAndRegisterPane } from '../../lib/createAgentPane.js'
import {
  buildEngineCommandArgv, buildEngineLaunchArgv, engineLaunchEnv, namedAgentArgs, permissionModeApproves, permissionModeFlags,
  launchAttempts, refusePermissionFlagIfUnsupported, supportsFirstPrompt, supportsNamedAgent, typedFirstPrompt, NamedAgentUnsupportedError,
} from '../../lib/engineLaunch.js'
import { joinedInstructions, launchSettingsArgs } from '../../engines/kit/launchValues.js'
import { errorKind } from '../../lib/log.js'
import { machineMcpLaunchArgs } from '../../lib/machineMcp.js'
import { writeGridConfigDir } from '../../lib/gridConfigDir.js'
import { describeGridLaunch, gridConfigHandOff, gridConflictingEnvToClear, type GridLaunchAnswer, type GridLaunchMachine, type GridLaunchRequest, type GridWebSearchStatus } from '../../lib/gridLaunchWire.js'
import { profileEnvironment } from '../../lib/engineHomes.js'
import { DEFAULT_HARNESS_PERMISSION, freshHarnessEnvironment } from '../../lib/harnessDefaults.js'
import { buildHarnessSessionLabel } from '../../lib/harnessSessionLabel.js'
import type { LaunchAuthority, LaunchPreparation } from '../../lib/launchPreparation.js'
import type { publishGridConfigDir } from '../../lib/publishedGridConfig.js'
import { nativeHookLocations } from '../../engines/kit/nativeLocations.js'
import { hooksHeldDetail } from '../../engines/kit/hooksHeldDetail.js'
import type { PrepareFolderTrust } from '../../engines/folderTrustPreparation.js'
import { projectsRoot } from '../../lib/projectFolder.js'
import { NativeFiles } from '../../engines/kit/nativeFiles.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import type { TerminalBackend } from '../../lib/terminalBackend.js'
import { windowsLaunchRefusal } from '../../lib/windows/launch.js'
import { isWindowsHeldPane, windowsPaneLaunch } from '../../lib/windows/engineStart.js'
import { tmuxTooOldForSessionEnv } from '../../lib/tmuxVersion.js'
import { scmLaunchEnv } from '../../scm/launch.js'
import { mergedLaunchEnv } from './launchEnv.js'
import type { createPaneWatcher } from './newPane.js'

type CreateAgent = NonNullable<BackendSocket['onCreateAgent']>

export interface CreateAgentDeps {
  publishConfig?: typeof publishGridConfigDir
  native?: (engine: AgentEngine, source: NativeLaunchSource, authority: LaunchAuthority) => Promise<NativeLaunchResult>
  /** The backend new panes are made on; null where none is configured or could be readied. */
  createBackend: TerminalBackend | null
  /** Recheck a backend missing at boot after its runtime has been installed. Healthy launches never call it. */
  recoverBackend?: () => Promise<TerminalBackend | null>
  /** What a launch answers when [createBackend] is null: the configured backend's own code (terminalBackend.ts
   *  `noBackendCode`); `TMUX_UNAVAILABLE`, as before, by default. */
  noBackendCode?: string
  registry: typeof registry
  externalResume: CreateAgent
  watchNewPane: ReturnType<typeof createPaneWatcher>
  announceSession: (session: RegisteredSession) => void
  /** A look at the new agent, for the services that follow agents (core/agentLife.ts `running`). */
  attach: (session: RegisteredSession) => void
  prepareInstructions: (cwd: string | null | undefined, engine: string) => Promise<void>
  prepareFolderTrust?: PrepareFolderTrust
  /** The hook server's port, which installed engine hooks post to. */
  hookPort: number
  /** Whether engine hooks are installed at all (DISABLE_HOOK_INSTALL). */
  hooksDisabled: boolean
  /** The facts about this machine a launch of `engine` needs (lib/gridLaunch.ts). */
  gridLaunchMachine: (engine: AgentEngine, native?: NativeLaunch) => GridLaunchMachine | Promise<GridLaunchMachine>
  /** A grid or saved-API launch, built by the models service (core/agents/launch.ts `gridLaunchThrough`): the core
   *  builds none itself, and a create on a grid while models is down is refused (GRID_UNAVAILABLE). */
  buildGridLaunch: (request: GridLaunchRequest) => Promise<GridLaunchAnswer>
  terminalHintMachineName: () => string
  /** Whether a folder is being purged (PurgeAgentService.blocksFolder). */
  blocksFolder: (cwd: string) => boolean | undefined
  dshLaunch: Pick<DshThrough, 'describe' | 'context' | 'materialize' | 'launch'>
  /** A profile home's MCP config written with the connections' entries, by connected services (core/api.ts
   *  `ConnectorsPort`): bounded, and answered nothing while they are off, failing or slow. Never rejects. */
  syncProfileHome: ConnectorsPort['syncProfileHome']
}

function isFolder(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

/** A create held because [engine]'s hooks are not in place (kit/hooksHeldDetail.ts). */
function hooksHeld(engine: string, waiting: string) {
  return { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: hooksHeldDetail(engine, waiting) } as const
}

export function createAgentCreator({
  native: inspectNative, publishConfig, createBackend: initialBackend, recoverBackend, noBackendCode = 'TMUX_UNAVAILABLE', registry, externalResume, watchNewPane, announceSession, attach,
  prepareInstructions, prepareFolderTrust, hookPort, hooksDisabled, gridLaunchMachine, buildGridLaunch, terminalHintMachineName, blocksFolder,
  dshLaunch, syncProfileHome,
}: CreateAgentDeps) {
  const prepare = async (input: Parameters<CreateAgent>[0], authority: LaunchAuthority,
    context?: { local: boolean; folderTrustAttempted?: true }): Promise<LaunchPreparation<Awaited<ReturnType<CreateAgent>>>> => {
    const requireUnusedWorkspace = input.requireUnusedWorkspace === true
    if (input.resumeSessionId) return { ok: true, dispatch: () => externalResume(input) }
    const stale = () => ({ ok: false as const, error: 'LAUNCH_AUTHORITY_CHANGED', unavailable: 'launch', detail: 'Waiting for the original launch request’s authority.' })
    if (!authority.current()) return stale()
    let { engine, cwd, bypassPermission, permissionMode, grid: requestedGrid, codexHome, claudeHome, dsh, prompt, name, agent, scmLaunchRecord, startedBy, parentAgentId, launchModel, browser } = input
    let grid: GridLaunchRequest['override'] | null = requestedGrid
    const openclawLocal = input.openclawLocal ?? undefined
    // Checked again here: a saved launch runs later, and a run without its folder never falls back to the shared one.
    if (openclawLocal && !isFolder(openclawLocal)) return { ok: false, error: 'OPENCLAW_FOLDER_GONE', detail: OPENCLAW_LOCAL.folderGone }
    let createBackend = initialBackend
    if (!createBackend && recoverBackend) {
      createBackend = await recoverBackend()
      if (!authority.current()) return stale()
    }
    if (!createBackend) return { ok: false, error: noBackendCode }
    if (blocksFolder(cwd)) return { ok: false, error: 'WORKTREE_BUSY' }
    const workspaceIdentity = () => { const info = statSync(cwd), directory = realpathSync(cwd); return { identity: `${info.dev}:${info.ino}:${directory}`, directory } }
    let originalWorkspace: ReturnType<typeof workspaceIdentity>
    try {
      if (!statSync(cwd).isDirectory()) return { ok: false, error: 'CWD_NOT_FOUND' }
      originalWorkspace = workspaceIdentity()
    } catch {
      return { ok: false, error: 'CWD_NOT_FOUND' }
    }
    const workspaceRefusal = (): { ok: false; error: string } | null => {
      if (!requireUnusedWorkspace) return null
      let target: ReturnType<typeof workspaceIdentity>
      try { target = workspaceIdentity() } catch { return { ok: false, error: 'CWD_CHANGED' } }
      if (target.identity !== originalWorkspace.identity) return { ok: false, error: 'CWD_CHANGED' }
      // Repeated sessions in one folder need one filesystem lookup per synchronous scan. The
      // scratch bound never limits membership: later distinct paths are still checked, uncached.
      const seen = new Set<string>()
      for (const row of registry.rows()) {
        const path = row.cwd
        if (!path || seen.has(path)) continue
        if (seen.size < 1024) seen.add(path)
        let canonical: string
        try { canonical = realpathSync(path) } catch { canonical = path }
        if (canonical === target.directory) return { ok: false, error: 'WORKSPACE_IN_USE' }
      }
      return null
    }
    const occupied = workspaceRefusal()
    if (occupied) return occupied
    // The local Desktop already made this workspace. Observe emptiness before any
    // preparation writes, but grant trust only after its dependencies are ready.
    const trustEmptyProject = context?.local === true && !context.folderTrustAttempted && !dsh && dirname(cwd) === projectsRoot()
      && await readdir(cwd).then(names => names.length === 0, () => false)
    if (!authority.current()) return stale()
    // A harness can pin its permission mode (`dshPinnedPermissionMode`): the Grid harness starts model
    // servers, which Codex's sandbox would start without a GPU. Pinned before anything reads the mode,
    // and recorded on the row like a chosen one, so a relaunch keeps it.
    const description = dsh ? await dshLaunch.describe(dsh, engine) : null
    if (!authority.current()) return stale()
    if (description && !description.ok) return description
    const pinnedDsh = description
    const pinnedMode = pinnedDsh?.permissionMode
    if (pinnedMode && permissionModeFlags(engine, pinnedMode)) {
      permissionMode = pinnedMode
      bypassPermission = permissionModeApproves(pinnedMode)
    }
    if (!inspectNative && !isTerminalEngine(engine)) return hooksHeld(engine, 'Waiting for engine setup.')
    const inspected = await inspectNative?.(engine, { ...input, permissionMode, bypassPermission }, authority)
    // An engine that ran and failed, or whose install for this request failed, is refused with its own
    // reason. Held, a creation retried every two seconds and could start, task and all, whenever the
    // engine was repaired: a Codex installed with npm on a computer without Node (fresh Ubuntu VM,
    // 2026-10-11) held for good, and `harness new` said only that it could not confirm. A relaunch,
    // which nobody is waiting on, still holds.
    if (inspected && !inspected.ok) return inspected.refusal ? { ok: false, error: inspected.refusal, detail: inspected.detail } : inspected
    const native = inspected?.ok ? inspected.launch : undefined
    // Only a launch prepared for this folder starts a local run: any other would run on the shared state folder.
    if (openclawLocal && native?.openclawLocal !== openclawLocal) return { ok: false, error: 'OPENCLAW_LOCAL_UNPREPARED', detail: OPENCLAW_LOCAL.unprepared }
    if (engine === 'codex' && native) codexHome = nativeHookLocations(native.environment).CODEX_HOME
    const current = () => authority.current() && (!native || native.current())
    if (!current()) return stale()
    if (native && agent && !supportsNamedAgent(engine, native.opencodeMajor)) {
      return { ok: false, error: 'AGENT_UNSUPPORTED', detail: new NamedAgentUnsupportedError(engine).message }
    }
    // An engine too old for the flag this permission mode launches it with prints its help and
    // exits; the wrapper then hands the pane to a shell, and what the person gets is a terminal
    // full of help text with nothing anywhere saying why (openharness#285, opencode without
    // `--auto`). Refuse before opening a pane — this is a launch somebody is waiting on, and Ask
    // works today. Codex has been checked this way since it gained `--approve-for-me`; every other
    // engine with a permission flag was not, and carried the same failure.
    const refusal = await refusePermissionFlagIfUnsupported(engine, { permissionMode, bypassPermission }, native)
    if (!current()) return stale()
    if (refusal) {
      console.warn(`[agent] create refused · ${engine} · ${refusal.detail}`)
      return { ok: false, ...refusal }
    }
    // Native version and model control are eager; optional readers never decide whether a launch can proceed.
    // Harness-created sessions are easy to distinguish from a user's organic tmux sessions while
    // retaining the engine and a collision-resistant creation suffix for diagnostics. Computed
    // before the grid block because a file-configured engine keys its config directory on it.
    // The `harness-` prefix is also discovery's whitelist for a pane nobody tagged (see `ownedHere` /
    // `TmuxBackend.inventory()`): the panes this daemon creates carry its tag, which goes with them into
    // any session the person moves them to.
    const label = authority.label
    // Prepare the harness workspace, then bind its session context to the selected engine.
    // Missing packages or invalid runtimes refuse the launch before the agent is started.
    let dshEnv: Record<string, string> | undefined
    let dshArgs: string[] = []
    /** A DSH's own name ("Blender"), which the agent is named after instead of its engine. */
    let dshLabel: string | undefined
    /** What the harness is told about the signed-in account (its private grid), not left to guess. */
    let dshAccount: DshAccount = {}
    if (dsh) {
      const installed = pinnedDsh!
      const refusal = installed.refusal
      if (refusal) {
        return { ok: false, error: 'INVALID_DSH', detail: refusal }
      }
      if (!(await createBackend.capabilities()).sessionEnv) {
        const detail = `${tmuxTooOldForSessionEnv('a new session')} — so ${installed.name} `
          + `could not tell ${engine} which harness it is. Upgrade tmux.`
        console.warn(`[agent] create ${dsh} refused · ${detail}`)
        return { ok: false, error: 'TMUX_TOO_OLD_FOR_DSH', detail }
      }
    }
    // A grid is the user's answer to "where should this run", so every way of not honouring it is a
    // refusal rather than a fallback — an agent silently started on the engine's own login spends the
    // wrong account and looks identical to one that worked. Asked of models before a harness's workspace is
    // laid out or trusted: a create refused here leaves the folder as it was.
    const built = grid ? await buildGridLaunch({ engine, override: grid, machine: await gridLaunchMachine(engine, native), refresh: true }) : null
    if (!current()) return stale()
    if (built && !built.ok) {
      console.warn(`[agent] create ${engine} refused · ${built.detail}`)
      return built
    }
    // Models may have refreshed a Saved API. Keep the resulting launch and its record together;
    // the input remains the original request, including when a durable receipt owns it.
    if (built) grid = built.override
    if (dsh) {
      // Checked above: a harness that is not installed was refused before models was asked.
      const harness = pinnedDsh!
      try {
        const context = await dshLaunch.context({ dsh, engine })
        if (!current()) return stale()
        if (!context.ok) return context
        dshAccount = context.account
        const occupied = workspaceRefusal()
        if (occupied) return occupied
        const materialized = await dshLaunch.materialize({ dsh, workspace: cwd, account: dshAccount, engine, key: label })
        if (!current()) return stale()
        if (!materialized.ok) {
          if (materialized.unavailable) return materialized
          throw new Error(materialized.detail)
        }
        for (const warning of materialized.warnings) console.warn(`[dsh] ${dsh} materialize · ${warning}`)
        console.log(`[dsh] ${dsh} materialized ${cwd} · created ${materialized.created.length} · kept ${materialized.kept.length}`)
        // Store's template label is not proof of its final contents: another writer may have
        // added work while materialization or init awaited. Keep the engine's own question.
        if (materialized.created.some(item => item.startsWith('template'))) console.warn('[trust] TEMPLATE_TRUST_UNCONFIRMED')
      } catch (error) {
        const detail = `could not prepare the workspace for ${dsh} · ${error instanceof Error ? error.message : error}`
        console.warn(`[agent] create ${dsh} refused · could not prepare the workspace for ${dsh} · ${errorKind(error)}`)
        return { ok: false, error: 'DSH_MATERIALIZE_FAILED', detail }
      }
      const prepared = await dshLaunch.launch({ dsh, workspace: cwd, engine, key: label, account: dshAccount },
        { ids: [harness.id, dsh], workspace: originalWorkspace.directory })
      if (!current()) return stale()
      if (!prepared.ok) return { ok: false, error: prepared.error, detail: prepared.detail,
        ...(prepared.unavailable ? { unavailable: prepared.unavailable } : {}) }
      dshEnv = prepared.launch.env
      dshArgs = prepared.launch.args
      dshLabel = harness.name
    }
    let gridLaunch: { env: Record<string, string>; args: string[]; webSearch: GridWebSearchStatus } | undefined
    if (grid && built?.ok) {
      if (!(await createBackend.capabilities()).sessionEnv) {
        const detail = `${tmuxTooOldForSessionEnv('a new session')} — so ${engine} could not have been pointed at grid `
          + `${grid.networkName}. Upgrade tmux, or create this agent without a grid selected.`
        console.warn(`[agent] create ${engine} refused · ${detail}`)
        return { ok: false, error: 'TMUX_TOO_OLD_FOR_GRID', detail }
      }
      if (!current()) return stale()
      gridLaunch = { env: { ...built.launch.env }, args: built.launch.args, webSearch: built.launch.webSearch }
      // An engine whose provider lives in a file gets a directory this daemon owns, never the
      // user's own dotfiles. The label is unique per creation, so two agents never share one.
      if (built.launch.configDir) {
        const { files, links } = built.launch.configDir
        try {
          const publication = native && publishConfig ? await publishConfig(label, files, links, current) : null
          if (publication && !native?.retain?.(publication.proof)) return stale()
          const dir = publication?.directory ?? await writeGridConfigDir(label, files, links)
          const handOff = gridConfigHandOff(built.launch.configDir, dir)
          Object.assign(gridLaunch.env, handOff.env)
          gridLaunch.args = [...gridLaunch.args, ...handOff.args]
        } catch (error) {
          const detail = `could not write ${engine}'s grid configuration · ${error instanceof Error ? error.message : error}`
          console.warn(`[agent] create ${engine} refused · could not write ${engine}'s grid configuration · ${errorKind(error)}`)
          return { ok: false, error: 'GRID_CONFIG_FAILED', detail, unavailable: 'native' }
        }
      }
      // Named in the log because the pane itself gives nothing away: the engine looks exactly like a
      // normally launched one. The key is never printed.
      console.log(describeGridLaunch(engine, grid, built.launch.webSearch))
    }
    if (!current()) return stale()
    if (trustEmptyProject) {
      const trustCurrent = () => {
        try { return current() && workspaceIdentity().identity === originalWorkspace.identity } catch { return false }
      }
      try {
        // A clone or user edit can arrive while dependencies are being prepared.
        // Trust only the same physical workspace, still empty at the write boundary.
        const files = new NativeFiles()
        const eligible = files.entries(cwd).length === 0
        if (!current()) return stale()
        if (eligible && workspaceIdentity().identity === originalWorkspace.identity) {
          files.verify()
          const environment = native ? { ...native.environment, ...gridLaunch?.env, ...dshEnv } : undefined
          const profile = engine === 'codex' && environment ? nativeHookLocations(environment).CODEX_HOME : engine === 'claude' ? claudeHome : codexHome
          await prepareFolderTrust?.({ engine, cwd, profile, environment, empty: true }, trustCurrent)
        }
      } catch (caughtFailure) { console.warn(('[trust] FOLDER_TRUST_UNAVAILABLE') + ' · ' + errorKind(caughtFailure)) }
      if (!trustCurrent()) return stale()
    }
    if (!current()) return stale()
    if (native && !await native.prepareHooks(hooksDisabled ? 0 : hookPort, authority.current,
      { ...gridLaunch?.env, ...dshEnv }, gridLaunch ? gridConflictingEnvToClear(gridLaunch) : [])) return hooksHeld(engine, 'Waiting to confirm the engine’s native hooks.')
    // Harness configuration can change the profile after executable discovery. Binding and Resume
    // must retain the home the prepared child will actually use.
    if (engine === 'codex' && native) codexHome = nativeHookLocations(native.environment).CODEX_HOME
    // An agent on a profile home reads that home's MCP config, not the default's: it gets the connections there too,
    // before it starts. Written in the edge host; one that does not answer in time leaves the config as it is.
    const profileHome = engine === 'claude' ? claudeHome : engine === 'codex' ? codexHome : null
    if (profileHome && (engine === 'claude' || engine === 'codex')) await syncProfileHome(engine, profileHome)
    // Clearing the vendor credentials this launch does NOT set is part of pointing an agent at a
    // grid, not an extra. An engine chooses its provider from whatever it can see, and an inherited
    // key wins on its own terms — OpenCode picked Anthropic over a grid it had been handed, and said
    // only `invalid x-api-key`. Nothing is cleared when no grid is in play: an agent on its own login
    // is supposed to use exactly these variables.
    const clearEnv = [...(gridLaunch ? gridConflictingEnvToClear(gridLaunch) : []), ...harnessEnvToClear(dshEnv)]
    // The named agent takes the same argv slot on every relaunch (`buildLaunchOverrides` appends it
    // from the row's `agent`, after the grid's and the DSH's argv, exactly as here). The engine was
    // checked for a contract at the wire (AGENT_UNSUPPORTED, opencode v2 included), so this cannot throw.
    const settings = await native?.prepareSettings?.(cwd, authority.current)
    if (!current()) return stale()
    // The person's machine MCP servers (lib/machineMcp.ts, #1872), beside the grid's and their own: read at each launch,
    // as every relaunch reads them again (`buildLaunchOverrides`).
    const machineMcp = machineMcpLaunchArgs(engine, cwd)
    const extraArgs = joinedInstructions(engine, [...(gridLaunch?.args ?? []), ...dshArgs, ...(agent ? namedAgentArgs(engine, agent, native?.opencodeMajor ?? null) : []), ...machineMcp])
    // The first prompt is a launch option only — never part of `extraArgs`, which the registry row
    // carries into a relaunch (engineLaunch.ts, `firstPrompt`).
    const firstPrompt = prompt
    // An engine that takes it typed gets it on its row instead, typed once its pane is ready (core/agents/bind.ts).
    const firstTask = typedFirstPrompt(engine, firstPrompt ?? undefined)
    // Chosen before the pane, so the launch can name its session after the agent (engineLaunch.ts `agentId`).
    const agentId = randomUUID()
    const baseOptions = { agentId, ...(native ? { native } : {}), bypassPermission, ...(permissionMode ? { permissionMode } : {}), extraArgs: extraArgs.length ? extraArgs : undefined, clearEnv, cwd, harnessNode: dsh ? true : undefined, ...(firstPrompt ? { firstPrompt } : {}), ...(launchModel ? { launchModel } : {}), terminalHint: { machineName: terminalHintMachineName() } }
    // Windows refuses a batch-file engine whose arguments cmd.exe would read (lib/windows/launch.ts), before any pane.
    try {
      buildEngineCommandArgv(engine, { ...baseOptions, extraArgs: launchSettingsArgs(engine, extraArgs, settings) })
    } catch (error) { return windowsLaunchRefusal(error) }
    // A tmux route is enough to stream its screen. Register it before looking for a process so both
    // loopback and relayed Desktop clients can attach while the login shell is still busy.
    // `tmuxBackend` exists whenever the CONFIG lists tmux — it is never a probe of the binary, so a
    // daemon that cannot resolve `tmux` at all (a login context whose PATH lacks Homebrew's bin, the
    // usual shape after a reboot) is reported as `TMUX_UNAVAILABLE` too, distinctly from a tmux that
    // answered and refused (`SPAWN_FAILED`) — see createAgentPane.ts. Registration itself is retried
    // there: a stale registry entry from a previous tmux-server generation occasionally collides with
    // a freshly-minted pane id, and that collision clears on its own on the very next pane.
    await prepareInstructions(cwd, engine)
    // Mutually exclusive with a grid (backendSocket.ts refuses the two together): a chosen Codex
    // profile becomes the new session's CODEX_HOME (its session store's variable, lib/engineHomes.ts
    // `profileEnvironment`), the same `-e` mechanism a grid's own env rides.
    if (!current()) return stale()
    return { ok: true, dispatch: async () => {
    if (!current()) return stale()
    const launchOptions = baseOptions
    let command: string[], windowsArgv: string[] | undefined
    try {
      command = buildEngineCommandArgv(engine, launchOptions)
      // Windows has no launch script: preserve its pure preflight and exact held-command identity.
      if (process.platform === 'win32') windowsArgv = buildEngineLaunchArgv(engine,
        { ...launchOptions, extraArgs: launchSettingsArgs(engine, extraArgs, settings) })
    } catch (error) { return windowsLaunchRefusal(error) }
    const held = windowsArgv !== undefined && isWindowsHeldPane(windowsArgv)
    const argv = held ? windowsArgv! : () => {
      const selectedArgs = launchSettingsArgs(engine, extraArgs, settings)
      const selected = { ...baseOptions, extraArgs: selectedArgs.length ? selectedArgs : undefined }
      command = buildEngineCommandArgv(engine, selected)
      return buildEngineLaunchArgv(engine, selected)
    }
    let dispatchRefusal: ReturnType<typeof workspaceRefusal> = null
    const result = await createAndRegisterPane({
      current, agentId, ...(native ? { nativeToken: native.token } : {}),
      ...(requireUnusedWorkspace ? { onDispatch: () => {
        // Synchronous: the backend does not yield between this scan and its final command send.
        dispatchRefusal = workspaceRefusal()
        if (dispatchRefusal) throw new Error(dispatchRefusal.error)
      } } : {}),
      tmuxBackend: createBackend,
      registry,
      engine,
      cwd,
      sessionLabel: label,
      argv: launchAttempts(argv, () => buildEngineLaunchArgv(engine, launchOptions)),
      // Windows: the workspace to start in and the shell the pane becomes after the engine (lib/windows/engineStart.ts).
      paneLaunch: windowsPaneLaunch(engine, { ...launchOptions, held }),
      // Windows: the variables the argv's `/usr/bin/env` prefix carries elsewhere, last (engineLaunchEnv).
      env: mergedLaunchEnv(freshHarnessEnvironment(engine, mergedLaunchEnv(mergedLaunchEnv(gridLaunch?.env ?? (codexHome ? profileEnvironment(engine, codexHome) : undefined), dshEnv),
        mergedLaunchEnv(scmLaunchEnv(scmLaunchRecord), native?.environment)), !!grid,
        permissionMode ?? (bypassPermission ? DEFAULT_HARNESS_PERMISSION : 'ask')), engineLaunchEnv(engine, native)),
      grid: grid ? { baseUrl: grid.baseUrl, model: grid.model ?? null } : null,
      gridLaunchRecord: grid && gridLaunch ? { override: grid, webSearch: gridLaunch.webSearch } : null,
      scmLaunchRecord: scmLaunchRecord ?? null,
      ...(launchModel ? { launchModel } : {}),
      codexHome,
      claudeHome,
      dsh,
      dshRuntime: dsh ? label : null,
      agent,
      bypassPermission,
      permissionMode,
      defaultName: name,
      label: dshLabel,
      startedBy: startedBy ?? null,
      parentAgentId: parentAgentId ?? null,
      ...(browser ? { browser: true } : {}),
      ...(firstTask ? { firstTask } : {}),
      ...(openclawLocal ? { openclawLocal } : {}),
    })
    if (!result.ok) return result.notStarted && dispatchRefusal ? dispatchRefusal : { ok: false, error: result.error, detail: result.detail }
    const { spawned, pending } = result
    // A terminal is ready the moment its pane is: there is no engine process to wait for, and the
    // shell exiting is the person closing it — so `remain-on-exit` comes off now, and the pane going
    // away is what removes the row (reconciler `onRemoved`), exactly as for an engine that quit.
    if (isTerminalEngine(engine)) {
      await createBackend.releaseHold(spawned.runtime)
      const ready = registry.setLaunch(pending.agentId, { state: 'ready' }) ?? pending
      announceSession(ready)
      console.log(`[agent] create terminal open · agent ${pending.agentId}`)
      return { ok: true, session: ready }
    }
    announceSession(pending)
    attach(pending)

    void watchNewPane(engine, pending, spawned, command, native?.executable)
    console.log(`[agent] create pane open · ${engine} · agent ${pending.agentId}`)
    return { ok: true, session: pending }
    } }
  }
  const createAgent: CreateAgent = async input => {
    const label = buildHarnessSessionLabel(input.engine)
    const prepared = await prepare(input, { id: label, label, current: () => true, hold: () => {} })
    return prepared.ok ? prepared.dispatch() : prepared
  }
  return Object.assign(createAgent, { prepare })
}
