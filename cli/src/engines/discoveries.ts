/**
 * What discovery reads off an engine's process and transcripts, composed from each engine's declared
 * discovery contract (engines/{claude,codex}/discoveryContract.ts) and the kit's mechanics, so the discovery
 * pass (lib/tmux.ts, lib/terminalAgentDiscovery.ts), the registry and the start-up repair name no engine.
 * All of it runs in core, in line: binding a session never waits on an engine worker.
 */
import { env } from '../config/env.js'
import { readProcessEnv } from '../lib/processEnv.js'
import type { ProcessIdentity } from '../lib/registry.js'
import { discovery as claude } from './claude/discoveryContract.js'
import { discovery as codex } from './codex/discoveryContract.js'
import type { DiscoveryContract } from './facets/discovery.js'
import { profileFromEnv, versionedInstallMatcher } from './kit/processFacts.js'
import { isProjectTranscript, projectDirectoryName, projectMatches, transcriptFolder } from './kit/projectFolder.js'
import type { AgentEngine } from './types.js'

export const discoveryContracts = { claude, codex } satisfies Record<string, DiscoveryContract>
type MigratedEngine = keyof typeof discoveryContracts

/** An engine's discovery contract, for an engine that declares one. */
export function discoveryContract(engine: AgentEngine | string): DiscoveryContract | undefined {
  return Object.hasOwn(discoveryContracts, engine) ? discoveryContracts[engine as MigratedEngine] : undefined
}

/** Compatibility tables take their migrated entries from the same contract. */
export function discoveryField<K extends keyof DiscoveryContract>(key: K): Record<MigratedEngine, DiscoveryContract[K]> {
  return Object.fromEntries(Object.entries(discoveryContracts).map(([name, contract]) => [name, contract[key]])) as Record<MigratedEngine, DiscoveryContract[K]>
}

/** The engines whose contract says `key`. */
export function enginesDeclaring(key: 'modelInArgv'): AgentEngine[] {
  return (Object.keys(discoveryContracts) as MigratedEngine[]).filter((engine) => discoveryContracts[engine][key])
}

/**
 * Whether a value (an executable or entrypoint) is the engine's native binary named only by its version, for
 * an engine that declares such an install; undefined for the rest. Compiled once, and looked up as a plain
 * property: every discovery pass asks this of every process row, for every engine. Measured on a fixed table
 * of 1,941 processes and 60 panes, two Map lookups per call cost the pass about 4%; this is within noise.
 */
export const versionedInstalls: Readonly<Partial<Record<AgentEngine, (value: string) => boolean>>> = Object.fromEntries(
  Object.entries(discoveryContracts).flatMap(([engine, contract]) =>
    contract.process.versionedInstall ? [[engine, versionedInstallMatcher(contract.process.versionedInstall)]] : []))

/**
 * The engine home a process runs under, read off its environment, when it is not this machine's default: a
 * path, `null` for the default (or an engine with no such profile), never a guess. `defaultHome` overrides
 * the daemon's own, for a caller that already holds it.
 */
export function profileHomeFromEnv(engine: AgentEngine, processEnv: Record<string, string>, defaultHome?: string): string | null {
  const profile = discoveryContract(engine)?.profile
  return profile ? profileFromEnv(profile, processEnv, defaultHome ?? env[profile.setting]) : null
}

/** The same, read from the live process: `undefined` when it could not be read, which never overwrites what
 *  the registry knows. One cached environment read per process, as the grid probe makes. */
export async function probeProfileHome(identity: ProcessIdentity, engine: AgentEngine): Promise<string | null | undefined> {
  if (!discoveryContract(engine)?.profile) return null
  const processEnv = await readProcessEnv(identity)
  if (!processEnv) return undefined
  return profileHomeFromEnv(engine, processEnv)
}

/** Which folder a transcript belongs to, for an engine that keeps transcripts by the folder they began in. */
export interface TranscriptProject {
  /** Whether the transcript sits in a project directory at all. */
  isProjectTranscript(transcriptPath: string): boolean
  /** Whether `cwd` is the folder this transcript belongs to, as given or as its real path. */
  belongs(cwd: string, transcriptPath: string): boolean
  /** The folder the transcript names for itself, read from it; null when it names none. */
  cwdOf(transcriptPath: string, limit?: number): string | null
  /** The project directory's name for a folder. */
  directoryOf(cwd: string): string
}

/** The project-folder rule of `engine`'s transcripts; null for an engine with no such rule. */
export function transcriptProject(engine: AgentEngine | string): TranscriptProject | null {
  const rule = discoveryContract(engine)?.projectFolder
  if (!rule) return null
  return {
    isProjectTranscript: (transcriptPath) => isProjectTranscript(rule, transcriptPath),
    belongs: (cwd, transcriptPath) => projectMatches(rule, cwd, transcriptPath),
    cwdOf: (transcriptPath, limit) => transcriptFolder(rule, transcriptPath, limit),
    directoryOf: (cwd) => projectDirectoryName(rule, cwd),
  }
}
