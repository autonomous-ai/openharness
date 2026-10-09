/** Native hook installation is eager. Optional transcript and screen readers own no hook files. */
import { join } from 'node:path'
import { env } from '../config/env.js'
import { VERSION } from '../version.js'
import { OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN, OPENCODE_LEGACY_REMOVAL } from './opencode/contract.js'
import { KILO_PLUGIN } from './kilo/contract.js'
import { PI_EXTENSION } from './pi/contract.js'
import { AMP_PLUGIN } from './amp/contract.js'
import { HERMES_HOOK_SETTINGS } from './hermes/contract.js'
import { opencodeMajorVersion } from './launchControl.js'
import { installNativePlugin, removeNativePlugin } from './kit/nativePlugin.js'
import { installNativeYamlHooks } from './kit/nativeHookYaml.js'
import { command } from './kit/notifyHooks.js'
import { GROK_HOOK_SETTINGS } from './grok/contract.js'
import { AGY_HOOK_SETTINGS } from './agy/contract.js'
import { COPILOT_HOOK_SETTINGS } from './copilot/contract.js'
import { CURSOR_HOOK_SETTINGS } from './cursor/contract.js'
import { COMMANDCODE_HOOK_SETTINGS } from './commandcode/contract.js'
import { DEVIN_HOOK_SETTINGS } from './devin/contract.js'
import { installNativeHookSettings } from './kit/nativeHookSettings.js'

export const installGrokHooks = (port: number): void => installNativeHookSettings(GROK_HOOK_SETTINGS, port)
export const installAgyHooks = (port: number): void => installNativeHookSettings(AGY_HOOK_SETTINGS, port)
export const installCopilotHooks = (port: number): void => installNativeHookSettings(COPILOT_HOOK_SETTINGS, port)
export const installCursorHooks = (port: number): void => installNativeHookSettings(CURSOR_HOOK_SETTINGS, port)
export const installCommandCodeHooks = (port: number): void => installNativeHookSettings(COMMANDCODE_HOOK_SETTINGS, port)
export const installDevinHooks = (port: number): void => installNativeHookSettings(DEVIN_HOOK_SETTINGS, port)

const pluginValues = (port: number) => ({
  port: String(port), credential: JSON.stringify(join(env.ADAPTER_DATA_DIR, 'hook-credential')), version: JSON.stringify(VERSION),
})
export const installKiloPlugin = (port: number): void => installNativePlugin(KILO_PLUGIN, pluginValues(port))
export const installPiExtension = (port: number): void => installNativePlugin(PI_EXTENSION, pluginValues(port))
export const installAmpPlugin = (port: number): void => installNativePlugin(AMP_PLUGIN, pluginValues(port))
export const installHermesHooks = (port: number): void =>
  installNativeYamlHooks(HERMES_HOOK_SETTINGS, home => command(port, 'hermes', env.CODEX_HOME, home))

/** Install both discovery surfaces for v1; v2 must not load our incompatible v1 export. */
export function installOpencodePlugin(port: number): void {
  const values = pluginValues(port)
  if (opencodeMajorVersion() === 1) installNativePlugin(OPENCODE_LEGACY_PLUGIN, values)
  else removeNativePlugin(OPENCODE_LEGACY_REMOVAL)
  installNativePlugin(OPENCODE_TUI_PLUGIN, values)
}
