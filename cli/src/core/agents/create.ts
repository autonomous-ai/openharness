/**
 * Creating an agent (`agent_create`): open a fresh pane running the chosen engine in the chosen
 * folder, as a domain-specific harness or a plain session, on a grid or the engine's own login, opening
 * a conversation Harness did not start when asked — and refuse, before any pane opens, every launch
 * that would not do what was asked. The pane is then watched until its engine is up.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 11: docs/design/2026-10-03-harnessd.md).
 */
import { statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackendSocket } from '../../backendSocket.js'
import type { ModelsPort } from '../api.js'
import { MODEL_MANAGER_ID } from '../../dsh/builtinIds.js'
import { installedDsh } from '../../dsh/installed.js'
import { harnessEnvToClear, type DshAccount } from '../../dsh/launch.js'
import { dshPinnedPermissionMode } from '../../dsh/manifest.js'
import { incompatibleHarnessEngine } from '../../dsh/compatibility.js'
import type { DshThrough } from './dshThrough.js'
import * as opencodeLaunch from '../../engines/launchControl.js'
import { isTerminalEngine, type AgentEngine } from '../../engines/types.js'
import { engineLabel } from '../../lib/agentNames.js'
import { createAndRegisterPane } from '../../lib/createAgentPane.js'
import { enginePathOverride } from '../../lib/engineBin.js'
import { engineInstallRecipe } from '../../lib/engineInstall.js'
import {
  buildEngineCommandArgv, buildEngineLaunchArgv, namedAgentArgs, permissionModeApproves, permissionModeFlags,
  refusePermissionFlagIfUnsupported, supportsFirstPrompt,
} from '../../lib/engineLaunch.js'
import { setUpWithin } from '../../lib/setUpWithin.js'
import { writeGridConfigDir } from '../../lib/gridConfigDir.js'
import { describeGridLaunch, gridConflictingEnvToClear, type GridLaunchAnswer, type GridLaunchMachine, type GridLaunchRequest, type GridWebSearchStatus } from '../../lib/gridLaunchWire.js'
import { profileEnvironment } from '../../lib/engineHomes.js'
import { DEFAULT_HARNESS_PERMISSION, freshHarnessEnvironment } from '../../lib/harnessDefaults.js'
import { buildHarnessSessionLabel } from '../../lib/harnessSessionLabel.js'
import { engineHooks } from '../../engines/hooks.js'
import { folderTrust } from '../../engines/launchPrep.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import { clearPaneRemainOnExit } from '../../lib/tmux.js'
import type { TmuxBackend } from '../../lib/tmuxBackend.js'
import { TMUX_SESSION_ENV_MIN, tmuxSupportsSessionEnv } from '../../lib/tmuxVersion.js'
import { prepareInstructionWrites, scmLaunchEnv } from '../../scm/scmProjects.js'
import { mergedLaunchEnv } from './launchEnv.js'
import type { createPaneWatcher } from './newPane.js'

/** How long creating a Model Manager waits for grid to be set up before its workspace asks grid which
 *  grid is this account's. Short: the app gives the whole create 20s, and a first install takes minutes.
 *  Past it the set-up carries on, and the agent's own `harness grid setup` waits for it. */
const MODEL_MANAGER_GRID_WAIT_MS = 8_000

type CreateAgent = NonNullable<BackendSocket['onCreateAgent']>

export interface CreateAgentDeps {
  /** The tmux backend; null where the configuration lists no tmux. */
  tmuxBackend: TmuxBackend | null
  registry: typeof registry
  externalResume: CreateAgent
  watchNewPane: ReturnType<typeof createPaneWatcher>
  announceSession: (session: RegisteredSession) => void
  attachDsh: (session: RegisteredSession) => void
  prepareApiTools: (cwd: string | null | undefined, engine: string) => void
  /** The hook server's port, which installed engine hooks post to. */
  hookPort: number
  /** Whether engine hooks are installed at all (DISABLE_HOOK_INSTALL). */
  hooksDisabled: boolean
  /** OpenCode's plugin, installed again before an OpenCode spawn (core/engines/hooks.ts
   *  `installOpencodePluginBeforeSpawn`): eager, independent of optional interpretation. */
  installOpencodePlugin: (port: number) => Promise<boolean>
  /** The facts about this machine a launch of `engine` needs (lib/gridLaunch.ts). */
  gridLaunchMachine: (engine: AgentEngine) => GridLaunchMachine
  /** A grid or saved-API launch, built by the models service (core/agents/launch.ts `gridLaunchThrough`): the core
   *  builds none itself, and a create on a grid while models is down is refused (GRID_UNAVAILABLE). */
  buildGridLaunch: (request: GridLaunchRequest) => Promise<GridLaunchAnswer>
  terminalHintMachineName: () => string
  /** Whether a folder is being purged (PurgeAgentService.blocksFolder). */
  blocksFolder: (cwd: string) => boolean | undefined
  /** Grid set-up, when this daemon can do it: the models service's (core/api.ts `ModelsPort.ensure`), null
   *  while it is off. */
  gridSetup: () => ModelsPort['ensure'] | null
  privateGridName: () => Promise<string | null>
  dshLaunch: Pick<DshThrough, 'materialize' | 'launch'>
}

export function createAgentCreator({
  tmuxBackend, registry, externalResume, watchNewPane, announceSession, attachDsh,
  prepareApiTools, hookPort, hooksDisabled, installOpencodePlugin, gridLaunchMachine, buildGridLaunch, terminalHintMachineName, blocksFolder,
  gridSetup, privateGridName, dshLaunch,
}: CreateAgentDeps) {
  const createAgent: CreateAgent = async input => {
    if (input.resumeSessionId) return externalResume(input)
    let { engine, cwd, bypassPermission, permissionMode, grid, codexHome, dsh, prompt, name, agent, scmLaunchRecord } = input
    if (!tmuxBackend) return { ok: false, error: 'TMUX_UNAVAILABLE' }
    if (blocksFolder(cwd)) return { ok: false, error: 'WORKTREE_BUSY' }
    try {
      if (!statSync(cwd).isDirectory()) return { ok: false, error: 'CWD_NOT_FOUND' }
    } catch {
      return { ok: false, error: 'CWD_NOT_FOUND' }
    }
    // A harness can pin its permission mode (`dshPinnedPermissionMode`): the Grid harness starts model
    // servers, which Codex's sandbox would start without a GPU. Pinned before anything reads the mode,
    // and recorded on the row like a chosen one, so a relaunch keeps it.
    const pinnedDsh = dsh ? installedDsh(dsh) : null
    const pinnedMode = pinnedDsh ? dshPinnedPermissionMode(pinnedDsh.manifest) : null
    if (pinnedMode && permissionModeFlags(engine, pinnedMode)) {
      permissionMode = pinnedMode
      bypassPermission = permissionModeApproves(pinnedMode)
    }
    // An engine too old for the flag this permission mode launches it with prints its help and
    // exits; the wrapper then hands the pane to a shell, and what the person gets is a terminal
    // full of help text with nothing anywhere saying why (openharness#285, opencode without
    // `--auto`). Refuse before opening a pane — this is a launch somebody is waiting on, and Ask
    // works today. Codex has been checked this way since it gained `--approve-for-me`; every other
    // engine with a permission flag was not, and carried the same failure.
    const refusal = await refusePermissionFlagIfUnsupported(engine, { permissionMode, bypassPermission })
    if (refusal) {
      console.warn(`[agent] create refused · ${engine} · ${refusal.detail}`)
      return { ok: false, ...refusal }
    }
    // Native version and model control are eager; optional readers never decide whether a launch can proceed.
    const opencode = engine === 'opencode' ? opencodeLaunch : null
    // Harness-created sessions are easy to distinguish from a user's organic tmux sessions while
    // retaining the engine and a collision-resistant creation suffix for diagnostics. Computed
    // before the grid block because a file-configured engine keys its config directory on it.
    // The `harness-` prefix is also discovery's whitelist for a pane nobody tagged (see `ownedHere` /
    // `TmuxBackend.inventory()`): the panes this daemon creates carry its tag, which goes with them into
    // any session the person moves them to.
    const label = buildHarnessSessionLabel(engine)
    // Prepare the harness workspace, then bind its session context to the selected engine.
    // Missing packages or invalid runtimes refuse the launch before the agent is started.
    let dshEnv: Record<string, string> | undefined
    let dshArgs: string[] = []
    /** A DSH's own name ("Blender"), which the agent is named after instead of its engine. */
    let dshLabel: string | undefined
    /** What the harness is told about the signed-in account (its private grid), not left to guess. */
    let dshAccount: DshAccount = {}
    const installed = dsh ? installedDsh(dsh) : undefined
    if (dsh) {
      if (!installed) return { ok: false, error: 'INVALID_DSH', detail: `${dsh} is not installed on this machine` }
      if (installed.manifest.kind === 'viewer') return { ok: false, error: 'INVALID_DSH', detail: `${dsh} is a viewer package, not an agent` }
      const refusal = incompatibleHarnessEngine(dsh, installed.manifest, engine)
      if (refusal) {
        return { ok: false, error: 'INVALID_DSH', detail: refusal }
      }
      if (!(await tmuxSupportsSessionEnv())) {
        const detail = `this machine's tmux is older than ${TMUX_SESSION_ENV_MIN.major}.${TMUX_SESSION_ENV_MIN.minor}, `
          + `which is the first version that can give a new session its own environment — so ${installed.manifest.name} `
          + `could not tell ${engine} which harness it is. Upgrade tmux.`
        console.warn(`[agent] create ${dsh} refused · ${detail}`)
        return { ok: false, error: 'TMUX_TOO_OLD_FOR_DSH', detail }
      }
    }
    // A grid is the user's answer to "where should this run", so every way of not honouring it is a
    // refusal rather than a fallback — an agent silently started on the engine's own login spends the
    // wrong account and looks identical to one that worked. Asked of models before a harness's workspace is
    // laid out or trusted: a create refused here leaves the folder as it was.
    const built = grid ? await buildGridLaunch({ engine, override: grid, machine: gridLaunchMachine(engine) }) : null
    if (built && !built.ok) {
      console.warn(`[agent] create ${engine} refused · ${built.detail}`)
      return { ok: false, error: built.error, detail: built.detail }
    }
    if (dsh) {
      // Checked above: a harness that is not installed was refused before models was asked.
      const harness = installed!
      // The Model Manager is grid in use, however it was made (the Store, New Harness, `harness new`, the
      // models picker): grid is set up before the workspace asks it which grid is this account's.
      const ensureGrid = gridSetup()
      if (harness.id === MODEL_MANAGER_ID && ensureGrid) {
        const setUp = await setUpWithin(() => ensureGrid({ ownGrid: true }), MODEL_MANAGER_GRID_WAIT_MS)
        if (setUp === 'pending') console.log(`[dsh] ${dsh} · grid is still being set up; the agent waits for it with \`harness grid setup\``)
      }
      try {
        dshAccount = { privateGrid: await privateGridName().catch(() => null) }
        // Asked BEFORE the template goes in: afterwards every folder has content.
        // Not there yet is empty; unreadable is not — trust is only ever granted on evidence.
        const emptyBefore = await readdir(cwd).then((names) => names.length === 0,
          (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
        const materialized = await dshLaunch.materialize({ dsh, workspace: cwd, account: dshAccount, engine, key: label })
        if (!materialized.ok) {
          if (materialized.unavailable) return { ok: false, error: materialized.error, detail: materialized.detail }
          throw new Error(materialized.detail)
        }
        for (const warning of materialized.warnings) console.warn(`[dsh] ${dsh} materialize · ${warning}`)
        console.log(`[dsh] ${dsh} materialized ${cwd} · created ${materialized.created.length} · kept ${materialized.kept.length}`)
        // The template just went into an EMPTY folder: everything in it is the harness's, and Claude Code
        // need not ask. Laid into a folder that already held something — a clone, the person's own repo —
        // it proves nothing about the rest, so trust stays the person's call (engines/kit/folderTrust.ts).
        if (emptyBefore && materialized.created.some((item) => item.startsWith('template'))) {
          try {
            // In the agent's own profile when it has one: that config.toml is the one a Codex agent reads.
            folderTrust(engine, codexHome)?.record(cwd)
          } catch (error) { console.warn(`[dsh] pre-trust ${cwd} · ${error instanceof Error ? error.message : error}`) }
        }
      } catch (error) {
        const detail = `could not prepare the workspace for ${dsh} · ${error instanceof Error ? error.message : error}`
        console.warn(`[agent] create ${dsh} refused · ${detail}`)
        return { ok: false, error: 'DSH_MATERIALIZE_FAILED', detail }
      }
      const prepared = await dshLaunch.launch({ dsh, workspace: cwd, engine, key: label, account: dshAccount })
      if (!prepared.ok) return { ok: false, error: prepared.error, detail: prepared.detail }
      dshEnv = prepared.launch.env
      dshArgs = prepared.launch.args
      dshLabel = harness.manifest.name
    }
    let gridLaunch: { env: Record<string, string>; args: string[]; webSearch: GridWebSearchStatus } | undefined
    if (grid && built?.ok) {
      if (!(await tmuxSupportsSessionEnv())) {
        const detail = `this machine's tmux is older than `
          + `${TMUX_SESSION_ENV_MIN.major}.${TMUX_SESSION_ENV_MIN.minor}, which is the first version that can `
          + `give a new session its own environment — so ${engine} could not have been pointed at grid `
          + `${grid.networkName}. Upgrade tmux, or create this agent without a grid selected.`
        console.warn(`[agent] create ${engine} refused · ${detail}`)
        return { ok: false, error: 'TMUX_TOO_OLD_FOR_GRID', detail }
      }
      gridLaunch = { env: { ...built.launch.env }, args: built.launch.args, webSearch: built.launch.webSearch }
      // An engine whose provider lives in a file gets a directory this daemon owns, never the
      // user's own dotfiles. The label is unique per creation, so two agents never share one.
      if (built.launch.configDir) {
        const { envVar, files, pointAt, links } = built.launch.configDir
        try {
          const dir = await writeGridConfigDir(label, files, links)
          // Pi is handed the directory; OpenCode's OPENCODE_CONFIG wants the file inside it.
          gridLaunch.env[envVar] = pointAt ? join(dir, pointAt) : dir
        } catch (error) {
          const detail = `could not write ${engine}'s grid configuration · ${error instanceof Error ? error.message : error}`
          console.warn(`[agent] create ${engine} refused · ${detail}`)
          return { ok: false, error: 'GRID_CONFIG_FAILED', detail }
        }
      }
      // Named in the log because the pane itself gives nothing away: the engine looks exactly like a
      // normally launched one. The key is never printed.
      console.log(describeGridLaunch(engine, grid, built.launch.webSearch))
    }
    // A Codex agent pointed at a profile OTHER than this machine's default reads hooks.json from
    // THAT folder, not the one `harness login` already installed into — without this, such an agent
    // fires no hook at all (no SessionStart/UserPromptSubmit/Stop) and never streams a single event.
    // Idempotent, so paying this on every create against an already-set-up profile is free.
    if (codexHome && !hooksDisabled) engineHooks.codex.installIn(hookPort, codexHome)
    // OpenCode may have upgraded from 1.x to 2.x while this daemon was running. Its new TUI must
    // not discover our old server plugin; the cached version probe changes with the executable.
    // Native installation is eager. A plugin is how this engine tells the daemon its session.
    if (engine === 'opencode' && !hooksDisabled && !await installOpencodePlugin(hookPort)) {
      const detail = 'OpenCode\'s plugin installer could not be loaded'
      console.warn(`[agent] create opencode refused · ${detail}`)
      return { ok: false, error: 'ENGINE_UNAVAILABLE', detail }
    }
    // Do not start a second interactive login shell merely to ask whether the engine is installed.
    // The pane's own shell performs the same check before exec, and installs only when necessary.
    // This removes ~1s of shell startup from the click-to-terminal critical path.
    const installIfMissing = enginePathOverride(engine) ? undefined : engineInstallRecipe(engine)
    // Clearing the vendor credentials this launch does NOT set is part of pointing an agent at a
    // grid, not an extra. An engine chooses its provider from whatever it can see, and an inherited
    // key wins on its own terms — OpenCode picked Anthropic over a grid it had been handed, and said
    // only `invalid x-api-key`. Nothing is cleared when no grid is in play: an agent on its own login
    // is supposed to use exactly these variables.
    const clearEnv = [...(gridLaunch ? gridConflictingEnvToClear(gridLaunch) : []), ...harnessEnvToClear(dshEnv)]
    // The named agent takes the same argv slot on every relaunch (`buildLaunchOverrides` appends it
    // from the row's `agent`, after the grid's and the DSH's argv, exactly as here). The engine was
    // checked for a contract at the wire (AGENT_UNSUPPORTED, opencode v2 included), so this cannot throw.
    const extraArgs = [...(gridLaunch?.args ?? []), ...dshArgs, ...(agent ? namedAgentArgs(engine, agent, opencode ? opencode.opencodeMajorVersion() : null) : [])]
    // The first prompt is a launch option only — never part of `extraArgs`, which the registry row
    // carries into a relaunch (engineLaunch.ts, `firstPrompt`).
    const firstPrompt = prompt
    const launchOptions = { bypassPermission, ...(permissionMode ? { permissionMode } : {}), extraArgs: extraArgs.length ? extraArgs : undefined, installIfMissing, clearEnv, cwd, harnessNode: dsh ? true : undefined, ...(firstPrompt ? { firstPrompt } : {}), terminalHint: { machineName: terminalHintMachineName() } }
    const command = buildEngineCommandArgv(engine, launchOptions)
    const argv = buildEngineLaunchArgv(engine, launchOptions)
    // A tmux route is enough to stream its screen. Register it before looking for a process so both
    // loopback and relayed Desktop clients can attach while the login shell/installer is still busy.
    // `tmuxBackend` exists whenever the CONFIG lists tmux — it is never a probe of the binary, so a
    // daemon that cannot resolve `tmux` at all (a login context whose PATH lacks Homebrew's bin, the
    // usual shape after a reboot) is reported as `TMUX_UNAVAILABLE` too, distinctly from a tmux that
    // answered and refused (`SPAWN_FAILED`) — see createAgentPane.ts. Registration itself is retried
    // there: a stale registry entry from a previous tmux-server generation occasionally collides with
    // a freshly-minted pane id, and that collision clears on its own on the very next pane.
    await prepareInstructionWrites(cwd)
    prepareApiTools(cwd, engine)
    // Mutually exclusive with a grid (backendSocket.ts refuses the two together): a chosen Codex
    // profile becomes the new session's CODEX_HOME (its session store's variable, lib/engineHomes.ts
    // `profileEnvironment`), the same `-e` mechanism a grid's own env rides.
    const result = await createAndRegisterPane({
      tmuxBackend,
      registry,
      engine,
      cwd,
      sessionLabel: label,
      argv,
      env: freshHarnessEnvironment(engine, mergedLaunchEnv(mergedLaunchEnv(gridLaunch?.env ?? (codexHome ? profileEnvironment(engine, codexHome) : undefined), dshEnv),
        scmLaunchEnv(scmLaunchRecord)), !!grid,
        permissionMode ?? (bypassPermission ? DEFAULT_HARNESS_PERMISSION : 'ask')),
      grid: grid ? { baseUrl: grid.baseUrl, model: grid.model ?? null } : null,
      gridLaunchRecord: grid && gridLaunch ? { override: grid, webSearch: gridLaunch.webSearch } : null,
      scmLaunchRecord: scmLaunchRecord ?? null,
      codexHome,
      dsh,
      dshRuntime: dsh ? label : null,
      agent,
      bypassPermission,
      permissionMode,
      defaultName: name,
      label: dshLabel,
    })
    if (!result.ok) return { ok: false, error: result.error, detail: result.detail }
    const { spawned, pending } = result
    // A terminal is ready the moment its pane is: there is no engine process to wait for, and the
    // shell exiting is the person closing it — so `remain-on-exit` comes off now, and the pane going
    // away is what removes the row (reconciler `onRemoved`), exactly as for an engine that quit.
    if (isTerminalEngine(engine)) {
      await clearPaneRemainOnExit(spawned.runtime.paneId)
      const ready = registry.setLaunch(pending.agentId, { state: 'ready' }) ?? pending
      announceSession(ready)
      console.log(`[agent] create terminal open · agent ${pending.agentId}`)
      return { ok: true, session: ready }
    }
    announceSession(pending)
    if (pending.dsh) attachDsh(pending)

    void watchNewPane(engine, pending, spawned, command, installIfMissing, undefined)
    console.log(`[agent] create pane open · ${engine} · agent ${pending.agentId}`)
    return { ok: true, session: pending }
  }
  return createAgent
}
