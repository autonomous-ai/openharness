/** Optional source policy and its one derived artifact belong to engineSetup. */
import { errorKind } from '../lib/log.js'
import { lstatSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { agentSettingsFromText } from '../lib/agentSettings.js'
import { launchContract } from '../engines/launches.js'
import { nativeHookLocations } from '../engines/kit/nativeLocations.js'
import { instructionValueIn } from '../engines/kit/attribution.js'
import { preparedStatusLine, statusLineScript } from '../engines/kit/statusLine.js'
import { HookPreparationHeld, inspectHookFile, verifyHookFiles, type HookPreparationProof } from '../engines/kit/nativeHookFiles.js'
import { publishNativeFiles } from '../engines/kit/nativeHookPublication.js'
import { HOOK_TOTAL_LIMIT } from '../engines/kit/nativeHookWire.js'
import { boundedLaunchSettingsInput, launchSettingsCandidate, LAUNCH_SETTINGS_TIMEOUT_MS,
  type LaunchSettingsCandidate, type LaunchSettingsInput } from '../engines/kit/launchSettingsWire.js'

const SOURCE_LIMIT = 256

export const HARNESS_INSTRUCTIONS = 'You are running in Harness, and the person can watch you. You can hand work to other agents '
  + '(Claude Code, Codex) that run in their own harnesses: `harness new`, `harness wait`, `harness show`, `harness close` '
  + '(see `harness --help`). Start one only for work that can run in parallel, needs another model, or takes long; '
  + 'do quick work yourself, and close each one once you have its answer. Only use or close harnesses you started.'


/** Pure optional policy; the component supplies its bounded captured reader and owns all file effects. */
export function renderLaunchSettings(input: LaunchSettingsInput, dataDir: string, read: (file: string) => string | null): LaunchSettingsCandidate | null {
  const launch = launchContract(input.engine)!, homes = nativeHookLocations(input.environment)
  const files = { home: input.engine === 'claude' ? homes.CLAUDE_HOME : homes.CODEX_HOME,
    personal: input.environment.HOME!, cwd: input.cwd, read }
  const owner = input.owner && { machineId: input.owner.machineId, signInAcct: input.owner.accountId }
  const enabled = agentSettingsFromText(read(join(dataDir, 'agent-settings.json')), owner).agentsStartAgents
  const told = launch.harnessInstructions
  let instructions: string | null = enabled && told ? `${HARNESS_INSTRUCTIONS}${told.also ? ` ${told.also}` : ''}` : null
  if (instructions && told?.kind === 'config') instructions = instructionValueIn(told.config, [{ text: instructions, mark: instructions }], files)
  const destination = input.engine === 'claude' ? join(dataDir, 'statusline', 'statusline.mjs') : null
  const status = launch.statusLine && destination
    ? preparedStatusLine(launch.statusLine, files, dataDir, input.runtimeNode,
      () => destination, input.platform, input.gitBash) : null
  return launchSettingsCandidate({ version: 2, values: { instructions, settings: status ? JSON.stringify(status) : null } }, input)
}

/** Reads user files only. Commit may publish the fixed account-independent artifact, never a vendor config. */
export async function prepareNativeLaunchSettings(input: LaunchSettingsInput, dataDir: string, current: () => boolean,
  commit: () => Promise<boolean> = async () => current()): Promise<LaunchSettingsCandidate | null> {
  const deadline = performance.now() + LAUNCH_SETTINGS_TIMEOUT_MS
  const active = () => current() && performance.now() < deadline
  if (!active() || !boundedLaunchSettingsInput(input)) return null
  try {
    const launch = launchContract(input.engine)!, homes = nativeHookLocations(input.environment)
    const paths = new Set([join(dataDir, 'agent-settings.json')])
    const add = (file: string) => {
      paths.add(file)
      if (paths.size > SOURCE_LIMIT) throw new HookPreparationHeld('the launch settings source limit was reached')
    }
    if (launch.statusLine) {
      add(join(homes.CLAUDE_HOME, launch.statusLine.file))
      if (input.cwd) for (const file of launch.statusLine.folder) add(join(input.cwd, file))
    }
    if (launch.harnessInstructions?.kind === 'config') {
      const rule = launch.harnessInstructions.config, config = join(homes.CODEX_HOME, rule.file)
      add(config)
      // Distinct ancestor sources are bounded by add(), including a profile that is also the workspace.
      if (input.cwd) for (let dir = resolve(input.cwd); dir !== resolve(input.environment.HOME) && dir !== parse(dir).root; dir = dirname(dir)) {
        const file = join(dir, rule.folder)
        if (file !== config) add(file)
      }
    }
    let bytes = 0
    const observations = [...paths].map(file => {
      const observed = inspectHookFile(file)
      bytes += observed.content === null ? 0 : Buffer.byteLength(observed.content)
      if (bytes > HOOK_TOTAL_LIMIT) throw new HookPreparationHeld('the launch settings sources exceed their size limit')
      return { file, observed }
    })
    const destination = input.engine === 'claude' ? join(dataDir, 'statusline', 'statusline.mjs') : null
    const artifactRoute = () => {
      if (!destination) return
      // The data root may be an owner-configured alias; generated paths beneath it may not redirect user-file writes.
      for (const path of [dirname(destination), destination]) {
        try { if (lstatSync(path).isSymbolicLink()) throw new HookPreparationHeld('the optional artifact is an alias') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    }
    artifactRoute()
    const output = destination ? inspectHookFile(destination, 0o600) : null
    if (bytes + (output?.content ? Buffer.byteLength(output.content) : 0) > HOOK_TOTAL_LIMIT) {
      throw new HookPreparationHeld('the launch settings sources exceed their size limit')
    }
    const verify = () => {
      if (!active()) throw new HookPreparationHeld('the optional preparation was revoked')
      verifyHookFiles(observations); artifactRoute()
      if (!active()) throw new HookPreparationHeld('the optional preparation was revoked')
    }
    const captured = new Map(observations.map(({ file, observed }) => [file, observed.content]))
    // These paths are derived locally from the same contract the renderer reads; no external source list can omit one.
    const read = (file: string): string | null => captured.get(file)!
    const candidate = renderLaunchSettings(input, dataDir, read)
    if (!candidate) return null
    verify()
    if (!await commit()) return null
    if (!active()) throw new HookPreparationHeld('the optional preparation was revoked')
    let outputCurrent: (() => boolean) | undefined
    if (candidate.values.settings !== null) {
      const content = statusLineScript()
      if (output!.content === content) {
        // Equal bytes are a read-only artifact, not confirmation of a previous uncertain publication.
        output!.verify()
        outputCurrent = () => { try { output!.verify(); return true } catch { return false } }
      } else {
        // Publication needs a fresh source proof before its first effect; read-only reuse has the final proof below.
        verify()
        let published: HookPreparationProof | undefined
        const written = await publishNativeFiles([{ file: destination!, mode: 0o600, parentMode: 0o700 }], async files => {
          if (files[0].content !== content) output!.verify()
          return { version: 1, files: [{ index: 0, content }] }
        }, { current: active, verify, timeoutMs: Math.max(1, deadline - performance.now()),
          confirmed: proof => { published = proof }, identity: content })
        if (!written || !published) return null
        outputCurrent = published.current
      }
    } else verify()
    verify()
    return (!outputCurrent || outputCurrent()) && active() ? candidate : null
  } catch (caughtFailure) {
    console.warn(('[launch-settings] OPTIONAL_PREPARATION_UNAVAILABLE') + ' · ' + errorKind(caughtFailure))
    return null
  }
}
