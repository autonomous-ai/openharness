import type { EngineLaunch } from './facets/launch.js'
import type { AgentEngine } from './types.js'
import { launch as claude } from './claude/launch.js'
import { launch as codex } from './codex/launch.js'
import { contextArgsOf, envArgsOf, ownProviderArgs } from './kit/launchArgs.js'
import { launchHome } from '../lib/engineHomes.js'

/**
 * Launch metadata has no transcript imports: preparing argv must not load transcript readers. The contracts
 * are data; what reads them is the kit's (kit/launchArgs.ts, kit/launchStartup.ts), run in core, since a
 * launch is session control (docs/design/2026-10-08-engine-launch.md).
 */
export const engineLaunches = { claude, codex } satisfies Record<string, EngineLaunch>
type MigratedEngine = keyof typeof engineLaunches

/** An engine's launch contract, for an engine that declares one. Any name: a session row's engine is a string. */
export function launchContract(engine: AgentEngine | string): EngineLaunch | undefined {
  return Object.hasOwn(engineLaunches, engine) ? engineLaunches[engine as MigratedEngine] : undefined
}

/** The instruction file Harness writes its own notes into for `engine`, where it declares one. */
export function instructionFileOf(engine: AgentEngine | string): string | undefined {
  return launchContract(engine)?.instructionFile
}

/** Compatibility tables take their migrated entries from the same launch contract. */
export function launchField<K extends keyof EngineLaunch>(key: K): Record<MigratedEngine, EngineLaunch[K]> {
  return Object.fromEntries(Object.entries(engineLaunches).map(([name, launch]) => [name, launch[key]])) as Record<MigratedEngine, EngineLaunch[K]>
}

/** What a harness (dsh/adapters.ts) hands each engine: its instruction files, and its declared flags as argv. */
export const harnessAdapters = Object.fromEntries(Object.entries(engineLaunches).map(([name, launch]: [string, EngineLaunch]) => [name, {
  instructionFiles: launch.instructionFiles,
  ...(launch.contextArgs ? { contextArgs: contextArgsOf(launch.contextArgs) } : {}),
  ...(launch.envArgs ? { envArgs: envArgsOf(launch.envArgs) } : {}),
}])) as Record<MigratedEngine, {
  instructionFiles: readonly string[]
  contextArgs?: (contextFile: string) => string[]
  envArgs?: (env: Record<string, string>) => string[]
}>

/**
 * The argv that puts `engine` back on its own provider as it leaves a grid, or nothing for an engine that
 * keeps none of its own (`EngineLaunch.ownProvider`). Read from the home this launch's engine reads: the
 * agent's own profile, else the one the person's shell moves, else the daemon's (lib/engineHomes.ts).
 */
export function ownLoginProviderArgs(
  engine: AgentEngine,
  profile: string | null | undefined,
  deps: { read?: (path: string) => string | null; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const own = launchContract(engine)?.ownProvider
  return own ? ownProviderArgs(own, launchHome(own.home, profile, deps.env), deps.read) : []
}
