/**
 * argv-package — the deterministic spawn spec the real-matrix uses to reproduce EXACTLY what the
 * harness enters when an agent switches to a grid and back to its own login.
 *
 * It does NOT re-implement the launch. It reuses the harness's own builders
 * (`buildGridEngineLaunch` for the grid env/argv, `buildEngineCommandArgv` for the final command,
 * `gridEnvVarNames` for what to clear on the way home), so the matrix spawns the same argv the
 * daemon would, field for field — no drift, no self-rolled copy.
 */
import { type GridLaunchOverride, buildGridEngineLaunch, gridEnvVarNames } from '../lib/gridLaunch.js'
import { buildEngineCommandArgv } from '../lib/engineLaunch.js'
import type { AgentEngine } from '../engines/types.js'

/** A config file the launch writes into a private dir the engine is pointed at. */
export interface SpawnConfigFile {
  name: string
  content: string
}

/** Resolved spawn for one transition: what the daemon would hand `tmux respawn-pane`. */
export interface SpawnSpec {
  /** Full engine argv, `command[0]` is the engine binary (matches `buildEngineCommandArgv`). */
  command: string[]
  /** Environment layered over the engine's inherited env (where the grid key goes). */
  env: Record<string, string>
  /** Env vars that must be cleared so a stale grid/vendor credential is not inherited. */
  clearEnv: string[]
  /** A private config dir the engine reads its provider from (e.g. opencode), if any. */
  configDir?: {
    envVar: string
    pointAt?: string
    files: SpawnConfigFile[]
  }
}

export interface GridSpawnError {
  ok: false
  error: string
  detail: string
}

function refuse(error: string, detail: string): GridSpawnError {
  return { ok: false, error, detail }
}

/** Spawn spec to move `engine` onto `grid` (optionally resuming `resumeId`). */
export function gridSpawn(
  engine: AgentEngine,
  grid: GridLaunchOverride,
  resumeId?: string,
): SpawnSpec | GridSpawnError {
  const built = buildGridEngineLaunch(engine, grid, { hermesSystemManaged: false })
  if (!built.ok) {
    return { ok: built.ok, error: built.error, detail: built.detail }
  }
  const command = buildEngineCommandArgv(engine, {
    ...(resumeId ? { resumeSessionId: resumeId } : {}),
    extraArgs: built.launch.args,
  })
  return {
    command,
    env: built.launch.env,
    clearEnv: gridEnvVarNames(engine),
    ...(built.launch.configDir
      ? {
          configDir: {
            envVar: built.launch.configDir.envVar,
            ...(built.launch.configDir.pointAt ? { pointAt: built.launch.configDir.pointAt } : {}),
            files: built.launch.configDir.files.map((f) => ({ name: f.name, content: f.content })),
          },
        }
      : {}),
  }
}

/** Spawn spec to return `engine` to its own vendor login (clear the grid, nothing else set). */
export function backHomeSpawn(engine: AgentEngine, resumeId?: string): SpawnSpec {
  const command = buildEngineCommandArgv(engine, {
    ...(resumeId ? { resumeSessionId: resumeId } : {}),
  })
  return { command, env: {}, clearEnv: gridEnvVarNames(engine) }
}
