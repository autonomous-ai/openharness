/** Core captures bounded inputs and publishes its own script. Optional preparation cannot hold a native launch. */
import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { launchContract } from '../launches.js'
import type { NativeSetup } from './nativeSetup.js'
import { nativeHookLocations } from './nativeLocations.js'
import { HookPreparationHeld, inspectHookFile, type HookPreparationProof } from './nativeHookFiles.js'
import { publishNativeFiles } from './nativeHookPublication.js'
import { HOOK_TOTAL_LIMIT } from './nativeHookWire.js'
import { boundedLaunchSettingsInput, launchSettingsCandidate, LAUNCH_SOURCE_LIMIT, type LaunchSettingsInput } from './launchSettingsWire.js'

export interface PreparedLaunchSettings {
  readonly values: Readonly<{ instructions: string | null; settings: string | null }>
  /** Called again at final argv use; stale optional data is omitted, never a native-session hold. */
  current(): boolean
}
export interface LaunchSettingsOptions {
  dataDir: string
  runtimeNode: string
  platform: LaunchSettingsInput['platform']
  gitBash: string | null
  owner: LaunchSettingsInput['owner']
  /** Owner/revision admission; file freshness is checked separately at effects and final use. */
  current(): boolean
  nativeCurrent(): boolean
}

export async function prepareLaunchSettings(engine: string, environment: Readonly<Record<string, string>>, cwd: string | null,
  setup: Pick<NativeSetup, 'prepareFiles'>, options: LaunchSettingsOptions): Promise<PreparedLaunchSettings | null> {
  if ((engine !== 'claude' && engine !== 'codex') || !setup.prepareFiles || !options.current() || !options.nativeCurrent()) return null
  try {
    const launch = launchContract(engine)!, homes = nativeHookLocations(environment)
    const paths = new Set([join(options.dataDir, 'agent-settings.json')])
    const add = (file: string) => {
      paths.add(file)
      if (paths.size > LAUNCH_SOURCE_LIMIT) throw new HookPreparationHeld('the launch settings source limit was reached')
    }
    if (launch.statusLine) {
      add(join(homes.CLAUDE_HOME, launch.statusLine.file))
      if (cwd) for (const file of launch.statusLine.folder) add(join(cwd, file))
    }
    if (launch.harnessInstructions?.kind === 'config') {
      const rule = launch.harnessInstructions.config, config = join(homes.CODEX_HOME, rule.file)
      add(config)
      if (cwd) for (let dir = resolve(cwd), depth = 0; dir !== resolve(environment.HOME) && dir !== parse(dir).root; dir = dirname(dir)) {
        if (++depth > LAUNCH_SOURCE_LIMIT) throw new HookPreparationHeld('the launch settings ancestor limit was reached')
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
    const verify = () => {
      if (!options.current()) throw new HookPreparationHeld('the optional launch owner changed')
      if (!options.nativeCurrent()) throw new HookPreparationHeld('the native launch proof changed')
      for (const source of observations) source.observed.verify()
      if (!options.current()) throw new HookPreparationHeld('the optional launch owner changed')
    }
    const current = () => { try { verify(); return true } catch { return false } }
    const destination = engine === 'claude' ? join(options.dataDir, 'statusline', 'statusline.mjs') : null
    const output = destination ? inspectHookFile(destination, 0o600) : null
    const input: LaunchSettingsInput = {
      purpose: 'launchSettings', engine, environment: { ...environment }, cwd, dataDir: options.dataDir,
      runtimeNode: options.runtimeNode, platform: options.platform, gitBash: options.gitBash,
      owner: options.owner && { ...options.owner }, sources: observations.map(({ file, observed }) => ({ file, content: observed.content })),
      files: output && destination ? [{ file: destination, directory: output.directory, content: output.content, mode: output.mode,
        ...(output.content === null ? {} : { alias: lstatSync(destination).isSymbolicLink() }) }] : [],
    }
    if (!boundedLaunchSettingsInput(input) || !current()) return null
    const candidate = launchSettingsCandidate(await setup.prepareFiles(input, randomUUID(), current), input)
    if (!candidate || !current()) return null
    let outputCurrent: (() => boolean) | undefined
    if (candidate.files.length) {
      const content = candidate.files[0].content
      if (output!.content === content) {
        // Reading an existing optional artifact makes no publication or durability claim.
        output!.verify()
        outputCurrent = () => { try { output!.verify(); return true } catch { return false } }
      } else {
        let published: HookPreparationProof | undefined
        // This one artifact is itself the reservation owner. Required multi-file hook publication is unchanged.
        const written = await publishNativeFiles([{ file: destination!, mode: 0o600, parentMode: 0o700 }], async files => {
          if (files[0].content !== content) output!.verify()
          return { version: 1, files: [{ index: 0, content }] }
        }, { current: options.current, verify, confirmed: proof => { published = proof }, identity: content })
        if (!written || !published) return null
        outputCurrent = published.current
      }
    }
    const finalCurrent = () => current() && (!outputCurrent || outputCurrent())
    return finalCurrent() ? { values: Object.freeze({ ...candidate.values }), current: finalCurrent } : null
  } catch {
    console.warn('[launch-settings] OPTIONAL_PREPARATION_UNAVAILABLE')
    return null
  }
}
