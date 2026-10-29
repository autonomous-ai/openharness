import type { SwarmSkill } from './savedSkill.js'
/**
 * What a pane has to be launched WITH, beyond the engine's own argv, for the engine to come back
 * where it was: on the same grid with the same credential, or under the same Codex profile.
 *
 * `agent_create` assembles this from the desktop's fresh `GridLaunchOverride`. Every later relaunch of
 * the same agent — a restart in place, a pane recreated after a reboot — has to assemble the SAME
 * thing from what the registry kept (`gridLaunch`, `codexHome`), or the engine silently comes back on
 * its own login, spending the wrong account while looking identical. Written once so the three
 * callers cannot drift: the half that drifts is the half nobody ran today.
 *
 * Dependency-injected like restoreAgents.ts, because the two machine-specific parts (the terminal
 * backend's capabilities and the config directory writer) are exactly the parts worth stubbing in a spec.
 */

import type { NativeLaunch, NativeLaunchResult, NativeLaunchSource } from '../engines/nativeLaunch.js'
import type { AgentEngine } from '../engines/types.js'
import { subscriptionModelLaunch } from './subscriptionModel.js'
import { ownLoginProviderArgs } from '../engines/launches.js'
import { namedAgentArgs, supportsNamedAgent } from './engineLaunch.js'
import { profileEnvironment } from './engineHomes.js'
import {
  gridConfigHandOff,
  gridConflictingEnvToClear,
  type GridEngineLaunch,
  type GridLaunchAnswer,
  type GridLaunchMachine,
  type GridLaunchOverride,
  type GridLaunchRecord,
  type GridLaunchRequest,
} from './gridLaunchWire.js'
import type { TerminalBackendCapabilities } from './terminalTypes.js'
import { tmuxTooOldForSessionEnv } from './tmuxVersion.js'
import { harnessEnvToClear } from '../dsh/launch.js'
import type { DshLaunchAnswer } from '../dsh/launchWire.js'
import { scmLaunchEnv } from '../scm/scmProjects.js'
import type { ScmLaunchRecord } from '../scm/types.js'
import { agentLaunchArgs, joinedInstructions, type StartedBy } from './agentAttribution.js'
import { machineMcpLaunchArgs } from './machineMcp.js'
import type { CreationAuthority } from './agentCreationReceipt.js'
import type { publishGridConfigDir } from './publishedGridConfig.js'
import { nativeHookLocations } from '../engines/kit/nativeLocations.js'

export interface LaunchOverrides {
  native?: NativeLaunch
  /** Layered over the pane's inherited environment. The grid key lives here, and only here. */
  env: Record<string, string>
  /** Appended to the engine's argv (`-c model_providers…`, `-m …`, `--mcp-config …`). */
  extraArgs: string[]
  /** Vendor credentials the launch must hide from the engine — see `gridConflictingEnvToClear`. */
  clearEnv: string[]
  /**
   * The grid launch this was built from and what building it decided about web search — present
   * only when this IS a grid launch. Exactly what `registry.setGridLaunch` keeps, so the caller
   * stores it as-is and cannot pair a status with the wrong override. A launch back onto the
   * engine's own login has no such thing to say.
   */
  gridLaunchRecord?: GridLaunchRecord
  /**
   * The `provider/model` a resumed OpenCode session has to be put on before this launch — OpenCode
   * restores a session's stored model whatever argv says. Present whenever the launch names one;
   * the caller applies it (`applyOpencodeSessionModel`).
   */
  sessionModel?: string
}

/** A refusal names the service that could not be asked (`unavailable`) when that is all that stopped it. */
export type LaunchOverridesResult =
  | { ok: true; overrides: LaunchOverrides }
  | { ok: false; error: string; detail: string; unavailable?: string; holdScope?: 'workspace' }

/** A preparation has consulted every required service; committing performs only local writes.
 * Keep the closure private to this attempt: it contains the current credentials, never a cache. */
export type LaunchPreparationResult =
  | { ok: true; commit: () => Promise<LaunchOverridesResult> }
  | Extract<LaunchOverridesResult, { ok: false }>

export interface LaunchOverridesDeps {
  publishConfig?: typeof publishGridConfigDir
  /** The facts about THIS machine a contract needs and cannot read for itself — see `GridLaunchMachine`. */
  machine: (engine: AgentEngine, native?: NativeLaunch) => GridLaunchMachine | Promise<GridLaunchMachine>
  /** A grid or saved-API launch, built by the models service (core/agents/launch.ts `gridLaunchThrough`): the core
   *  builds none itself. */
  gridLaunch: (request: GridLaunchRequest) => Promise<GridLaunchAnswer>
  writeGridConfigDir: (
    key: string,
    files: NonNullable<GridEngineLaunch['configDir']>['files'],
    links: NonNullable<GridEngineLaunch['configDir']>['links'],
  ) => Promise<string>
  /** What the backend the pane is made on can do (`TerminalBackend.capabilities`). */
  capabilities: () => Promise<TerminalBackendCapabilities>
  /** Install the daemon's hooks into a non-default Codex profile. The caller decides whether hook
   *  installation is enabled at all. */
  installCodexHooks: (codexHome: string) => boolean | Promise<boolean>
  /** Core composes eager native preparation; absent only for legacy/golden callers. */
  native?: (engine: AgentEngine, source: NativeLaunchSource, authority: Pick<CreationAuthority, 'id' | 'current'>) => Promise<NativeLaunchResult>
  prepareNative?: (native: NativeLaunch, current: () => boolean, environment?: Readonly<Record<string, string>>, clear?: readonly string[]) => Promise<boolean>
  /**
   * Read a Codex `config.toml`, for the provider an agent goes back to when it leaves a grid.
   *
   * A seam rather than a direct read: without it every relaunch built in a test would consult
   * whatever Codex configuration the machine running the test happens to have, and a developer who
   * had set `model_provider` would watch unrelated specs change their answer. Absent ⇒ the real
   * file. See `ownProvider` in `engines/codex/launch.ts`.
   */
  readCodexConfig?: (path: string) => string | null
  /** In the Harness Team account, for an engine it has not signed in itself: the owner's subscription through the
   *  owner's relay (team/relay.ts `teamRelayLaunch`), null otherwise. Absent ⇒ never. */
  ownerRelay?: (engine: AgentEngine) => Promise<{ env: Record<string, string>; args: string[] } | null>
  /** Prepare the saved harness context before restarting. Missing or broken packages refuse the
   * relaunch: starting a plain agent would silently change the user's chosen harness. */
  dshLaunch?: (dsh: string, workspace: string, engine: AgentEngine, runtimeKey: string) => Promise<DshLaunchAnswer>
  /** Read an engine's settings for the pull request line (engines/launches.ts `attributionArgs`). A seam, like
   *  `readCodexConfig`: absent ⇒ the real file. */
  readAttribution?: (path: string) => string | null
  /** What the Swarm prepares on every relaunch of a session it started: its skill file and instructions
   *  (lib/swarmSkills.ts) and the Harness GitHub App's git and gh (lib/swarmGitHub.ts), handed in by the core from
   *  superTabs/inCore.ts. Absent while the Swarm is off (`HARNESS_SWARM`), when such a session is not relaunched: as
   *  with a harness package that is missing, starting it without its role would silently change what it is. */
  swarm?: {
    prepare(workspace: string, saved: SwarmSkill): { instructions: string }
    github(key: string): { env: Record<string, string>; clearEnv: string[] } | null
    args(engine: string): string[]
  }
}

/** The answer to relaunching a Swarm session while the Swarm is off on this computer. */
export const SWARM_OFF = { ok: false, error: 'SWARM_SKILL_FAILED', detail: 'The Swarm is off on this computer (HARNESS_SWARM).' } as const

/** Where the agent should come back: the registry row, or an override the desktop just sent. */
export interface LaunchSource extends NativeLaunchSource {
  gridLaunch?: GridLaunchOverride | null
  codexHome?: string | null
  /**
   * The engine's OWN model to come back to, when this relaunch is a move off a grid.
   *
   * Ignored while `gridLaunch` is set — that launch names its own model. Absent means "let the
   * engine decide", which is what happens for an engine with no cited mechanism.
   */
  subscriptionModel?: string | null
  /** The DSH the agent was created as; its env rides on every relaunch (`HARNESS_DSH` included). */
  dsh?: string | null
  /** The session-scoped runtime bundle. Older rows use their stable agent id. */
  dshRuntime?: string | null
  swarmSkill?: SwarmSkill
  /** The workspace, for the DSH's `${workspace}` — the registry row's `cwd`. */
  cwd?: string | null
  /**
   * What the workspace's SCM needs re-applied to the pane — the registry row's `scmLaunch`. A git
   * worktree asks for nothing. Absent or null: no SCM prepared this folder, or the row predates it.
   */
  scmLaunch?: ScmLaunchRecord | null
  /**
   * The engine's named agent this pane was opened as (`agent_create`'s `agent`, opencode
   * `--agent <name>`). Part of every relaunch, unlike a first prompt: a pane opened as `harness-compute`
   * comes back as `harness-compute`, not as a general session with that agent's history.
   */
  agent?: string | null
  /** `agent` when another agent started it (the row's `startedBy`): every relaunch keeps its pull request line. */
  startedBy?: StartedBy | null
}

/** Fresh each time: callers hand `env` to tmux and may extend it, and a shared object would carry
 *  one relaunch's additions into the next. */
const noOverrides = (): LaunchOverrides => ({ env: {}, extraArgs: [], clearEnv: [] })

/**
 * Build the overrides for relaunching `engine` from `source`. `configKey` names the config directory
 * a file-configured engine gets (`writeGridConfigDir`); key it on the agent so relaunching the same
 * agent rewrites one directory rather than leaving a trail of them.
 *
 * A grid the launch cannot honour is a refusal, never a fallback — the rule `agent_create` sets.
 */
/**
 * The refusals that need nothing written: the engine has no way onto a grid, or this tmux cannot
 * give a pane its own environment. Split out so a caller with a live process to protect can refuse
 * BEFORE it decides to touch anything (retarget checks these ahead of its busy guards, and only
 * builds — config directory included — once it holds the pane).
 */
export async function validateLaunchOverrides(
  deps: Pick<LaunchOverridesDeps, 'capabilities' | 'machine' | 'gridLaunch'>,
  engine: AgentEngine,
  source: LaunchSource,
  native?: NativeLaunch,
): Promise<{ ok: true } | { ok: false; error: string; detail: string; unavailable?: string }> {
  if (!source.gridLaunch) return { ok: true }
  const built = await deps.gridLaunch({ engine, override: source.gridLaunch, machine: await deps.machine(engine, native) })
  if (!built.ok) return { ok: false, error: built.error, detail: built.detail, ...(built.unavailable ? { unavailable: built.unavailable } : {}) }
  return tmuxRefusal(deps, engine, source.gridLaunch)
}

/** Only a launch that SETS variables needs the tmux that can set them. */
async function tmuxRefusal(
  deps: Pick<LaunchOverridesDeps, 'capabilities'>, engine: AgentEngine, override: GridLaunchOverride,
): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  if ((await deps.capabilities()).sessionEnv) return { ok: true }
  return {
    ok: false,
    error: 'TMUX_TOO_OLD_FOR_GRID',
    detail: `${tmuxTooOldForSessionEnv('a pane')} — so ${engine} could not be `
      + `pointed at grid ${override.networkName}.`,
  }
}

export async function buildLaunchOverrides(
  deps: LaunchOverridesDeps,
  engine: AgentEngine,
  source: LaunchSource,
  configKey: string,
  current: () => boolean = () => true,
  capturedNative?: NativeLaunch,
): Promise<LaunchOverridesResult> {
  const prepared = await prepareLaunchOverrides(deps, engine, source, configKey, current, capturedNative)
  return prepared.ok ? prepared.commit() : prepared
}

/** Ask dependencies before writing a live pane's configuration or installing profile hooks.
 * A models answer followed by an unavailable Store used to overwrite the old grid files first. */
export async function prepareLaunchOverrides(
  deps: LaunchOverridesDeps,
  engine: AgentEngine,
  source: LaunchSource,
  configKey: string,
  current: () => boolean = () => true,
  capturedNative?: NativeLaunch,
): Promise<LaunchPreparationResult> {
  const changed = { ok: false, error: 'AGENT_CHANGED', detail: 'The harness changed or stopped during launch preparation.' } as const
  if (!current()) return changed
  if (source.swarmSkill && !deps.swarm) return SWARM_OFF
  const swarm = deps.swarm
  const owner = current
  source = structuredClone(source)
  const inspected = capturedNative ? { ok: true as const, launch: capturedNative } : await deps.native?.(engine, source, { id: configKey, current: owner })
  if (!current()) return changed
  if (inspected && !inspected.ok) return inspected
  const native = inspected?.ok ? inspected.launch : undefined
  if (engine === 'codex' && native) source.codexHome = nativeHookLocations(native.environment).CODEX_HOME
  current = () => owner() && native?.current() !== false
  if (!current()) return changed
  const machine = { ...await deps.machine(engine, native) }
  const base = await prepareBaseLaunchOverrides({ ...deps, machine: () => machine,
    ...(native && deps.publishConfig ? { writeGridConfigDir: async (key, files, links) => {
      const published = await deps.publishConfig!(key, files, links, current)
      if (!native.retain?.(published.proof)) throw Error('Generated configuration authority changed')
      return published.directory
    } } : {}),
  }, engine, source, configKey)
  if (!current()) return changed
  if (!base.ok) return base
  if (source.dsh && !source.cwd) return { ok: false, error: 'DSH_WORKSPACE_MISSING', detail: `${source.dsh} has no saved workspace` }
  let dsh: Extract<DshLaunchAnswer, { ok: true }>['launch'] | undefined
  if (source.dsh && source.cwd) {
    let prepared: DshLaunchAnswer | null
    try {
      prepared = await deps.dshLaunch?.(source.dsh, source.cwd, engine, source.dshRuntime ?? configKey) ?? null
    } catch (error) {
      return { ok: false, error: 'DSH_RUNTIME_FAILED', detail: String(error) }
    }
    if (!current()) return changed
    if (!prepared) return { ok: false, error: 'DSH_NOT_INSTALLED', detail: `${source.dsh} is not installed on this machine` }
    if (!prepared.ok) return { ok: false, error: prepared.error, detail: prepared.detail,
      ...(prepared.unavailable ? { unavailable: prepared.unavailable } : {}),
      ...(prepared.holdScope ? { holdScope: prepared.holdScope } : {}) }
    dsh = prepared.launch
  }
  let committed = false
  return { ok: true, commit: async () => {
    if (!current()) return changed
    if (committed) return { ok: false, error: 'LAUNCH_PREPARATION_USED', detail: 'Launch preparation must be requested again before another attempt.' }
    committed = true
    if (!current()) return changed
    const written = await base.commit()
    if (!current()) return changed
    if (!written.ok) return written
    let overrides = written.overrides
    if (dsh) {
      // The service's harness environment layers over the base exactly as in a fresh create.
      overrides = { ...overrides, env: { ...overrides.env, ...dsh.env }, extraArgs: [...overrides.extraArgs, ...dsh.args] }
    }
    // The workspace's own SCM binding layers last: it is the daemon's, like `HARNESS_*`, and neither a
    // grid nor a DSH has a say in which workspace the pane is bound to. Nothing for git, so a git row's
    // overrides are exactly what they were.
    // File-configured engines can move their native home. Prepare hooks after
    // those operation-owned locations are known, before any native dispatch.
    if (native && deps.prepareNative && !await deps.prepareNative(native, owner, overrides.env, overrides.clearEnv)) {
      return { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Waiting to confirm the engine’s native hook preparation.' }
    }
    if (!current()) return changed
    const scmEnv = scmLaunchEnv(source.scmLaunch)
    if (scmEnv) overrides = { ...overrides, env: { ...overrides.env, ...scmEnv } }
    // A session started for another person's project keeps git and gh on the Harness GitHub App (lib/swarmGitHub.ts).
    if (source.swarmSkill?.github) {
      let github: ReturnType<NonNullable<LaunchOverridesDeps['swarm']>['github']>
      try { github = swarm!.github(source.swarmSkill.key) } catch (error) { return { ok: false, error: 'SWARM_SKILL_FAILED', detail: String(error) } }
      if (github) overrides = { ...overrides, env: { ...overrides.env, ...github.env }, clearEnv: [...overrides.clearEnv, ...github.clearEnv] }
    }
    // The named agent rides every relaunch, in the same argv slot `agent_create` put it in. Only an
    // engine with a contract could have had it recorded (create refuses the rest, AGENT_UNSUPPORTED),
    // so the guard is for a row edited by hand — it relaunches as a general session rather than
    // handing the engine a flag it does not know. The same guard covers an opencode agent created on
    // v1 and relaunched on v2, whose TUI has no `--agent`: a resumed v2 session keeps the agent it
    // stored (`session_v2.agent`), so nothing is lost by not naming it.
    const opencodeMajor = machine.opencodeMajor ?? null
    if (source.agent && supportsNamedAgent(engine, opencodeMajor)) {
      overrides = { ...overrides, extraArgs: [...overrides.extraArgs, ...namedAgentArgs(engine, source.agent, opencodeMajor)] }
    }
    // The person's machine MCP servers (lib/machineMcp.ts, #1872), in the slot `agent_create` gave them, read again.
    const machineMcp = machineMcpLaunchArgs(engine, source.cwd ?? null)
    if (machineMcp.length) overrides = { ...overrides, extraArgs: [...overrides.extraArgs, ...machineMcp] }
    // What the Swarm adds for its own sessions (core/api.ts `SwarmLaunch.args`), in the slot `agent_create` gave it.
    if (source.swarmSkill) overrides = { ...overrides, extraArgs: [...overrides.extraArgs, ...swarm!.args(engine)] }
    // What Harness tells the agent rides every relaunch, in the slot `agent_create` gave it: last. Read again each
    // time, with the person's switches and settings as they are now.
    let swarmInstructions: string | undefined
    if (source.swarmSkill) {
      try {
        if (!source.cwd) throw new Error('The Swarm session has no saved workspace')
        swarmInstructions = swarm!.prepare(source.cwd, source.swarmSkill).instructions
      } catch (error) { return { ok: false, error: 'SWARM_SKILL_FAILED', detail: String(error) } }
    }
    const told = agentLaunchArgs(engine, source.startedBy, {
      cwd: source.cwd ?? null, profile: source.codexHome, environment: native?.environment, read: deps.readAttribution, ...(swarmInstructions ? { swarmInstructions } : {}),
    })
    if (told.length) overrides = { ...overrides, extraArgs: joinedInstructions(engine, [...overrides.extraArgs, ...told]) }
    return { ok: true, overrides: { ...overrides, ...(native ? { native, env: { ...overrides.env, ...native.environment } } : {}), clearEnv: [...overrides.clearEnv, ...harnessEnvToClear(overrides.env)] } }
  } }
}

async function prepareBaseLaunchOverrides(
  deps: LaunchOverridesDeps,
  engine: AgentEngine,
  source: LaunchSource,
  configKey: string,
): Promise<LaunchPreparationResult> {
  // Coming back to the engine's own login undoes TWO things the grid launch set, and they are
  // undone separately because the engine remembers them differently.
  //
  //   * The MODEL — re-selected so the engine does not fall back to a house default. See
  //     `subscriptionModel.ts` for why an engine with no cited mechanism is given nothing rather
  //     than a guess.
  //   * The PROVIDER — named again, because Codex persists the grid's in state of its own that
  //     outlives the argv defining it, and a resume then fails before the TUI is up. See `ownProvider`
  //     in `engines/codex/launch.ts`.
  //
  // Accumulated rather than returned, because a Codex agent needs its profile (below) as well, and
  // an early return here used to drop it: a row with both a remembered model and a CODEX_HOME came
  // back on the DEFAULT profile, reading hooks from a folder that was not the one it writes to.
  let ownLogin: LaunchOverrides | null = null
  if (!source.gridLaunch) {
    const restored = subscriptionModelLaunch(engine, source.subscriptionModel, (await deps.machine(engine)).opencodeMajor ?? null)
    // In the Harness Team account, an engine it has not signed in itself spends the owner's subscription through the
    // owner's relay, on every relaunch as on its first: Codex keeps the relay's provider per thread, so it is named again
    // here in place of its own login's (two `-c model_provider` would leave Codex to pick one).
    const relay = await deps.ownerRelay?.(engine) ?? null
    // Ahead of the model on the command line: `-c` configures, `-m` selects, and Codex resolves the
    // model against the provider it has been given.
    const provider = relay ? relay.args : ownLoginProviderArgs(engine, source.codexHome, { read: deps.readCodexConfig })
    if (restored || provider.length || relay) {
      ownLogin = {
        env: { ...(relay?.env ?? {}), ...(restored?.env ?? {}) },
        extraArgs: [...provider, ...(restored?.args ?? [])],
        clearEnv: [],
        ...(restored?.sessionModel ? { sessionModel: restored.sessionModel } : {}),
      }
    }
  }
  if (source.gridLaunch) {
    // Built once, by the models service, with a saved API's endpoint and key as saved now: a removed API is
    // refused first, then an engine that cannot be pointed there, then a tmux that cannot set the variables.
    const built = await deps.gridLaunch({ engine, override: source.gridLaunch, machine: await deps.machine(engine), refresh: true })
    if (!built.ok) return { ok: false, error: built.error, detail: built.detail, ...(built.unavailable ? { unavailable: built.unavailable } : {}) }
    const tmux = await tmuxRefusal(deps, engine, built.override)
    if (!tmux.ok) return tmux
    return { ok: true, commit: async () => {
      const env: Record<string, string> = { ...built.launch.env }
      const args = [...built.launch.args]
      if (built.launch.configDir) {
        const { files, links } = built.launch.configDir
        try {
          const handOff = gridConfigHandOff(built.launch.configDir, await deps.writeGridConfigDir(configKey, files, links ?? []))
          Object.assign(env, handOff.env)
          args.push(...handOff.args)
        } catch (error) {
          const detail = `could not write ${engine}'s grid configuration · ${error instanceof Error ? error.message : error}`
          return { ok: false, error: 'GRID_CONFIG_FAILED', detail, ...(deps.native ? { unavailable: 'native' } : {}) }
        }
      }
      // Derived from what this launch actually provides (the config-dir variable included), so an
      // inherited vendor key never outranks the grid the engine was handed.
      return {
        ok: true,
        overrides: {
          env,
          extraArgs: args,
          clearEnv: gridConflictingEnvToClear({ env }),
          gridLaunchRecord: { override: built.override, webSearch: built.launch.webSearch },
          ...(built.launch.sessionModel ? { sessionModel: built.launch.sessionModel } : {}),
        },
      }
    } }
  }
  if (source.codexHome) {
    // A Codex agent on a profile OTHER than this machine's default reads hooks.json from THAT folder,
    // not the one `harness login` installed into — without this it fires no hook at all. Idempotent.
    const home = source.codexHome
    return { ok: true, commit: async () => {
      // A production native preparation covers the selected profile before any
      // grid/configuration commit. Legacy callers must also await and check it.
      if (!deps.native && !await deps.installCodexHooks(home)) return {
        ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Waiting to confirm Codex’s hooks in the selected profile.',
      }
      return {
        ok: true,
        overrides: {
          env: { ...profileEnvironment(engine, home), ...(ownLogin?.env ?? {}) },
          extraArgs: [...(ownLogin?.extraArgs ?? [])],
          clearEnv: [],
        },
      }
    } }
  }
  return { ok: true, commit: async () => ({ ok: true, overrides: ownLogin ?? noOverrides() }) }
}
