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
 * Dependency-injected like restoreAgents.ts, because the two machine-specific parts (the tmux version
 * probe and the config directory writer) are exactly the parts worth stubbing in a spec.
 */

import { join } from 'node:path'
import type { AgentEngine } from '../engines/types.js'
import { subscriptionModelLaunch } from './subscriptionModel.js'
import { ownLoginProviderArgs } from '../engines/codex/ownLoginProvider.js'
import { namedAgentArgs, supportsNamedAgent } from './engineLaunch.js'
import {
  buildGridEngineLaunch,
  gridConflictingEnvToClear,
  type GridEngineLaunch,
  type GridLaunchMachine,
  type GridLaunchOverride,
  type GridLaunchRecord,
} from './gridLaunch.js'
import { TMUX_SESSION_ENV_MIN } from './tmuxVersion.js'
import { harnessEnvToClear, type DshLaunch } from '../dsh/launch.js'

export interface LaunchOverrides {
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
}

export type LaunchOverridesResult =
  | { ok: true; overrides: LaunchOverrides }
  | { ok: false; error: string; detail: string }

export interface LaunchOverridesDeps {
  /** The facts about THIS machine a contract needs and cannot read for itself — see `GridLaunchMachine`. */
  machine: () => GridLaunchMachine
  writeGridConfigDir: (
    key: string,
    files: NonNullable<GridEngineLaunch['configDir']>['files'],
    links: NonNullable<GridEngineLaunch['configDir']>['links'],
  ) => Promise<string>
  tmuxSupportsSessionEnv: () => Promise<boolean>
  /** Install the daemon's hooks into a non-default Codex profile. The caller decides whether hook
   *  installation is enabled at all. */
  installCodexHooks: (codexHome: string) => void
  /**
   * Read a Codex `config.toml`, for the provider an agent goes back to when it leaves a grid.
   *
   * A seam rather than a direct read: without it every relaunch built in a test would consult
   * whatever Codex configuration the machine running the test happens to have, and a developer who
   * had set `model_provider` would watch unrelated specs change their answer. Absent ⇒ the real
   * file. See `engines/codex/ownLoginProvider.ts`.
   */
  readCodexConfig?: (path: string) => string | null
  /** Prepare the saved harness context before restarting. Missing or broken packages refuse the
   * relaunch: starting a plain agent would silently change the user's chosen harness. */
  dshLaunch?: (dsh: string, workspace: string, engine: AgentEngine, runtimeKey: string) => DshLaunch | null
}

/** Where the agent should come back: the registry row, or an override the desktop just sent. */
export interface LaunchSource {
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
  /** The workspace, for the DSH's `${workspace}` — the registry row's `cwd`. */
  cwd?: string | null
  /**
   * The engine's named agent this pane was opened as (`agent_create`'s `agent`, opencode
   * `--agent <name>`). Part of every relaunch, unlike a first prompt: a pane opened as `harness-compute`
   * comes back as `harness-compute`, not as a general session with that agent's history.
   */
  agent?: string | null
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
  deps: Pick<LaunchOverridesDeps, 'tmuxSupportsSessionEnv' | 'machine'>,
  engine: AgentEngine,
  source: LaunchSource,
): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  if (!source.gridLaunch) return { ok: true }
  const built = buildGridEngineLaunch(engine, source.gridLaunch, deps.machine())
  if (!built.ok) return { ok: false, error: built.error, detail: built.detail }
  // Only a launch that SETS variables needs the tmux that can set them.
  if (!(await deps.tmuxSupportsSessionEnv())) {
    return {
      ok: false,
      error: 'TMUX_TOO_OLD_FOR_GRID',
      detail: `this machine's tmux is older than ${TMUX_SESSION_ENV_MIN.major}.${TMUX_SESSION_ENV_MIN.minor}, `
        + `which is the first version that can give a pane its own environment — so ${engine} could not be `
        + `pointed at grid ${source.gridLaunch.networkName}.`,
    }
  }
  return { ok: true }
}

export async function buildLaunchOverrides(
  deps: LaunchOverridesDeps,
  engine: AgentEngine,
  source: LaunchSource,
  configKey: string,
): Promise<LaunchOverridesResult> {
  const base = await buildBaseLaunchOverrides(deps, engine, source, configKey)
  if (!base.ok) return base
  let overrides = base.overrides
  if (source.dsh && !source.cwd) return { ok: false, error: 'DSH_WORKSPACE_MISSING', detail: `${source.dsh} has no saved workspace` }
  if (source.dsh && source.cwd) {
    let dsh: DshLaunch | null
    try {
      dsh = deps.dshLaunch?.(source.dsh, source.cwd, engine, source.dshRuntime ?? configKey) ?? null
    } catch (error) {
      return { ok: false, error: 'DSH_RUNTIME_FAILED', detail: String(error) }
    }
    if (!dsh) return { ok: false, error: 'DSH_NOT_INSTALLED', detail: `${source.dsh} is not installed on this machine` }
    // The DSH's variables layer over the grid's or the profile's; `HARNESS_*` are the daemon's own
    // and a manifest cannot set them (see `dshLaunch`), so nothing here can shadow a grid credential.
    overrides = {
      ...overrides,
      env: { ...overrides.env, ...dsh.env },
      extraArgs: [...overrides.extraArgs, ...dsh.args],
    }
  }
  // The named agent rides every relaunch, in the same argv slot `agent_create` put it in. Only an
  // engine with a contract could have had it recorded (create refuses the rest, AGENT_UNSUPPORTED),
  // so the guard is for a row edited by hand — it relaunches as a general session rather than
  // handing the engine a flag it does not know.
  if (source.agent && supportsNamedAgent(engine)) {
    overrides = { ...overrides, extraArgs: [...overrides.extraArgs, ...namedAgentArgs(engine, source.agent)] }
  }
  return { ok: true, overrides: { ...overrides, clearEnv: [...overrides.clearEnv, ...harnessEnvToClear(overrides.env)] } }
}

async function buildBaseLaunchOverrides(
  deps: LaunchOverridesDeps,
  engine: AgentEngine,
  source: LaunchSource,
  configKey: string,
): Promise<LaunchOverridesResult> {
  const valid = await validateLaunchOverrides(deps, engine, source)
  if (!valid.ok) return valid
  // Coming back to the engine's own login undoes TWO things the grid launch set, and they are
  // undone separately because the engine remembers them differently.
  //
  //   * The MODEL — re-selected so the engine does not fall back to a house default. See
  //     `subscriptionModel.ts` for why an engine with no cited mechanism is given nothing rather
  //     than a guess.
  //   * The PROVIDER — named again, because Codex persists the grid's in state of its own that
  //     outlives the argv defining it, and a resume then fails before the TUI is up. See
  //     `engines/codex/ownLoginProvider.ts`.
  //
  // Accumulated rather than returned, because a Codex agent needs its profile (below) as well, and
  // an early return here used to drop it: a row with both a remembered model and a CODEX_HOME came
  // back on the DEFAULT profile, reading hooks from a folder that was not the one it writes to.
  let ownLogin: LaunchOverrides | null = null
  if (!source.gridLaunch) {
    const restored = subscriptionModelLaunch(engine, source.subscriptionModel)
    // Ahead of the model on the command line: `-c` configures, `-m` selects, and Codex resolves the
    // model against the provider it has been given.
    const provider = ownLoginProviderArgs(engine, source.codexHome, { read: deps.readCodexConfig })
    if (restored || provider.length) {
      ownLogin = {
        env: { ...(restored?.env ?? {}) },
        extraArgs: [...provider, ...(restored?.args ?? [])],
        clearEnv: [],
      }
    }
  }
  if (source.gridLaunch) {
    const built = buildGridEngineLaunch(engine, source.gridLaunch, deps.machine())
    if (!built.ok) return { ok: false, error: built.error, detail: built.detail }
    const env: Record<string, string> = { ...built.launch.env }
    if (built.launch.configDir) {
      const { envVar, files, pointAt, links } = built.launch.configDir
      try {
        const dir = await deps.writeGridConfigDir(configKey, files, links ?? [])
        // Pi is handed the directory; OpenCode's OPENCODE_CONFIG wants the file inside it.
        env[envVar] = pointAt ? join(dir, pointAt) : dir
      } catch (error) {
        const detail = `could not write ${engine}'s grid configuration · ${error instanceof Error ? error.message : error}`
        return { ok: false, error: 'GRID_CONFIG_FAILED', detail }
      }
    }
    // Derived from what this launch actually provides (the config-dir variable included), so an
    // inherited vendor key never outranks the grid the engine was handed.
    return {
      ok: true,
      overrides: {
        env,
        extraArgs: [...built.launch.args],
        clearEnv: gridConflictingEnvToClear({ env }),
        gridLaunchRecord: { override: source.gridLaunch, webSearch: built.launch.webSearch },
      },
    }
  }
  if (source.codexHome) {
    // A Codex agent on a profile OTHER than this machine's default reads hooks.json from THAT folder,
    // not the one `harness login` installed into — without this it fires no hook at all. Idempotent.
    deps.installCodexHooks(source.codexHome)
    return {
      ok: true,
      overrides: {
        env: { CODEX_HOME: source.codexHome, ...(ownLogin?.env ?? {}) },
        extraArgs: [...(ownLogin?.extraArgs ?? [])],
        clearEnv: [],
      },
    }
  }
  if (ownLogin) return { ok: true, overrides: ownLogin }
  return { ok: true, overrides: noOverrides() }
}
