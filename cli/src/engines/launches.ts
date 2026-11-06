import type { AttributionContract, EngineLaunch, StatusLineContract } from './facets/launch.js'
import type { AgentEngine } from './types.js'
import { launch as claude } from './claude/launch.js'
import { launch as codex } from './codex/launch.js'
import { attributionArgsIn, attributionInstruction, instructionsArgsIn, type Instruction } from './kit/attribution.js'
import { contextArgsOf, envArgsOf, fill, ownProviderArgs, readConfig } from './kit/launchArgs.js'
import { joinedSettings, statusLineSetting } from './kit/statusLine.js'
import { claudeCodeGitBash } from './claude/gitBash.js'
import { env } from '../config/env.js'
import { launchHome, launchHomeOf, launchPersonalHome } from '../lib/engineHomes.js'

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

/** Where a launch reads the person's settings from, for `attributionArgs`. */
export interface AttributionPlace {
  /** The harness's folder, or null where it has none. */
  cwd: string | null
  /** The agent's own engine home (a Codex agent's profile), where the engine's home takes one. */
  profile?: string | null
  /** The launch's environment as its shell set it (a native launch's); the daemon's launch environment when absent. */
  environment?: NodeJS.ProcessEnv
  /** A seam, like `readCodexConfig`: a spec's launch reads no settings of the machine it runs on. The real file when absent. */
  read?: (path: string) => string | null
  /** A Swarm session's instructions (lib/agentAttribution.ts): its folder is a branch, whose own settings are not run. */
  swarmInstructions?: string
}

/**
 * The argv that has `engine` add `line` to the pull requests it opens (`EngineLaunch.attribution`), from the person's
 * settings as this launch would read them: nothing for an engine that declares no way to, or where they hid the
 * engine's own attribution (kit/attribution.ts). Read at each launch, as the person may change them in between.
 */
export function attributionArgs(engine: AgentEngine | string, line: string, place: AttributionPlace): string[] {
  const contract = launchContract(engine)?.attribution
  return contract ? attributionArgsIn(contract, line, attributionFiles(contract, place)) : []
}

const attributionFiles = (contract: AttributionContract, place: AttributionPlace) => ({
  home: launchHomeOf(contract.home, place.profile, place.environment), personal: launchPersonalHome(place.environment),
  cwd: place.cwd, read: place.read ?? readConfig,
})

/**
 * The argv that tells `engine` Harness's own instructions ([instructions], `EngineLaunch.harnessInstructions`) and, with
 * [prLine], has it add that line to its pull requests (`attributionArgs`): for an engine that keeps both in one config
 * value (Codex), in one argument, as two of the same `-c` would leave only the last. Nothing for what the engine declares
 * no way to take, or where the person's settings say not to.
 */
export function agentInstructionArgs(engine: AgentEngine | string, said: { instructions: string | null; prLine: string | null }, place: AttributionPlace): string[] {
  const launch = launchContract(engine)
  const attribution = launch?.attribution
  const told = launch?.harnessInstructions
  const status = statusLineArgs(launch?.statusLine, place)
  if (!attribution && !told) return status
  said = { ...said, instructions: said.instructions && told?.also ? `${said.instructions} ${told.also}` : said.instructions }
  if (attribution?.kind === 'instruction') {
    const instructions: Instruction[] = [
      ...(said.instructions && told?.kind === 'attribution' ? [{ text: said.instructions, mark: said.instructions }] : []),
      ...(said.prLine ? [attributionInstruction(attribution, said.prLine)] : []),
    ]
    return [...instructionsArgsIn(attribution, instructions, attributionFiles(attribution, place)), ...status]
  }
  const setting = said.prLine && attribution ? attributionArgsIn(attribution, said.prLine, attributionFiles(attribution, place)) : []
  // Only beside the setting it backs: where the person's settings hide the engine's attribution, neither is given.
  const reminder = setting.length && attribution?.instruction ? attributionInstruction({ instruction: attribution.instruction }, said.prLine!).text : null
  const texts = told?.kind === 'append' ? [said.instructions, reminder].filter((text): text is string => !!text) : []
  const args = [...setting, ...status, ...(texts.length && told?.kind === 'append' ? told.args.map((arg) => fill(arg, 'text', texts.join('\n\n'))) : [])]
  return launch?.statusLine ? joinedSettings(launch.statusLine.args[0]!, args) : args
}

/**
 * The argv that gives a launch Harness's status line (kit/statusLine.ts): every session of an engine that declares one,
 * the person's own or an agent's. A Swarm session's folder is a branch, which could commit a status line command, and
 * one Harness ran would run outside the setting sources its launch keeps to (claude/launch.ts `teamWritten`): only the
 * person's own settings are read for it.
 */
function statusLineArgs(contract: StatusLineContract | undefined, place: AttributionPlace): string[] {
  if (!contract) return []
  const files = { home: launchHomeOf(contract.home, place.profile, place.environment), personal: launchPersonalHome(place.environment),
    cwd: place.cwd, read: place.read ?? readConfig, folder: !place.swarmInstructions }
  const setting = statusLineSetting(contract, files, env.ADAPTER_DATA_DIR, process.platform,
    () => claudeCodeGitBash({ env: place.environment ?? process.env }))
  return setting ? contract.args.map((arg) => fill(arg, 'settings', JSON.stringify(setting))) : []
}
