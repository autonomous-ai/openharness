/** Optional settings are component snapshots; the core retains only final launch authority. */
import { randomUUID } from 'node:crypto'
import type { NativeSetup } from './nativeSetup.js'
import { boundedLaunchSettingsInput, launchSettingsCandidate, type LaunchSettingsInput } from './launchSettingsWire.js'

export interface PreparedLaunchSettings {
  readonly values: Readonly<{ instructions: string | null; settings: string | null }>
  /** Final owner/native authority; optional files were validated when the component committed its snapshot. */
  current(): boolean
}
export interface LaunchSettingsOptions {
  runtimeNode: string
  platform: LaunchSettingsInput['platform']
  gitBash: string | null
  owner: LaunchSettingsInput['owner']
  current(): boolean
  nativeCurrent(): boolean
}

export async function prepareLaunchSettings(engine: string, environment: Readonly<Record<string, string>>, cwd: string | null,
  setup: Pick<NativeSetup, 'prepareSettings'>, options: LaunchSettingsOptions): Promise<PreparedLaunchSettings | null> {
  const current = () => options.current() && options.nativeCurrent() && options.current()
  if ((engine !== 'claude' && engine !== 'codex') || !setup.prepareSettings || !current()) return null
  try {
    const input: LaunchSettingsInput = { purpose: 'launchSettings', version: 2, engine, environment: { ...environment }, cwd,
      runtimeNode: options.runtimeNode, platform: options.platform, gitBash: options.gitBash,
      owner: options.owner && { ...options.owner } }
    if (!boundedLaunchSettingsInput(input)) return null
    const candidate = launchSettingsCandidate(await setup.prepareSettings(input, randomUUID(), current), input)
    return candidate && current() ? { values: Object.freeze({ ...candidate.values }), current } : null
  } catch {
    console.warn('[launch-settings] OPTIONAL_PREPARATION_UNAVAILABLE')
    return null
  }
}
