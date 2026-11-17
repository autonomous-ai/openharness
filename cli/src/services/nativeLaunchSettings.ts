/** Optional vendor settings are interpreted in engineSetup, using only the launch's captured sources. */
import { join } from 'node:path'
import { agentSettingsFromText } from '../lib/agentSettings.js'
import { launchContract } from '../engines/launches.js'
import { nativeHookLocations } from '../engines/kit/nativeLocations.js'
import { instructionValueIn } from '../engines/kit/attribution.js'
import { preparedStatusLine, statusLineScript } from '../engines/kit/statusLine.js'
import { boundedLaunchSettingsInput, launchSettingsCandidate, type LaunchSettingsCandidate, type LaunchSettingsInput } from '../engines/kit/launchSettingsWire.js'

export const HARNESS_INSTRUCTIONS = 'You are running in Harness, and the person can watch you. You can hand work to other agents '
  + '(Claude Code, Codex) that run in their own harnesses: `harness new`, `harness wait`, `harness show`, `harness close` '
  + '(see `harness --help`). Start one only for work that can run in parallel, needs another model, or takes long; '
  + 'do quick work yourself, and close each one once you have its answer. Only use or close harnesses you started.'

export async function prepareNativeLaunchSettings(input: LaunchSettingsInput, current: () => boolean): Promise<LaunchSettingsCandidate | null> {
  if (!current() || !boundedLaunchSettingsInput(input)) return null
  const captured = new Map(input.sources.map(source => [source.file, source.content]))
  // An omitted source is not an absent file. It cannot let a worker infer defaults for an uncaptured ancestor.
  const read = (file: string): string | null => {
    if (!captured.has(file)) throw new Error('LAUNCH_SETTINGS_SOURCE_MISSING')
    return captured.get(file)!
  }
  const launch = launchContract(input.engine)!, homes = nativeHookLocations(input.environment)
  const files = { home: input.engine === 'claude' ? homes.CLAUDE_HOME : homes.CODEX_HOME,
    personal: input.environment.HOME!, cwd: input.cwd, read }
  const owner = input.owner && { machineId: input.owner.machineId, signInAcct: input.owner.accountId }
  const enabled = agentSettingsFromText(read(join(input.dataDir, 'agent-settings.json')), owner).agentsStartAgents
  const told = launch.harnessInstructions
  let instructions: string | null = enabled && told ? `${HARNESS_INSTRUCTIONS}${told.also ? ` ${told.also}` : ''}` : null
  if (instructions && told?.kind === 'config') {
    instructions = instructionValueIn(told.config, [{ text: instructions, mark: instructions }], files)
  }
  const status = launch.statusLine && input.files.length
    ? preparedStatusLine(launch.statusLine, files, input.dataDir, input.runtimeNode,
      () => input.files[0].file, input.platform, input.gitBash) : null
  const candidate = { version: 1, values: { instructions, settings: status ? JSON.stringify(status) : null },
    files: status ? [{ index: 0, content: statusLineScript() }] : [] }
  return current() ? launchSettingsCandidate(candidate, input) : null
}
